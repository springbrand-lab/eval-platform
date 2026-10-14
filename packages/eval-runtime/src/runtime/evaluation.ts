import type {
  EvaluationAgentOutput,
  EvaluationAttempt,
  EvaluationRecord,
  HarnessConfig,
  RetryPolicy,
  SamplingStatus,
} from "@eval-platform/eval-contracts";
import { dataInputSchema } from "@eval-platform/eval-dataset";

import type { RuntimeEvaluationContext, Sample } from "./model.js";
import type { RuntimeStore } from "./store.js";
import { RuntimeRecordPersistenceError, persistRuntimeRecord, sameRuntimeRecordFacts } from "./store.js";
import type { RetryController } from "./retry.js";
import {
  AgentOperationError,
  applyAttemptPatch,
  describeAgentError,
  requireSpHarness,
  runAgentLifecycle,
  type AgentLifecycleDependencies,
} from "./agent-lifecycle.js";

export interface EvaluationStageDependencies extends AgentLifecycleDependencies {
  readonly store: RuntimeStore;
  readonly createRetryController: (policy?: RetryPolicy) => RetryController;
}

export interface EvaluateSamplingInput {
  readonly context: RuntimeEvaluationContext;
  readonly harnessConfig: HarnessConfig;
  readonly retryPolicy: RetryPolicy;
}

export function requireEvaluationPrompt(sample: Sample): string {
  const prompt = sample.data && typeof sample.data === "object" && !Array.isArray(sample.data)
    ? sample.data.evalPrompt : undefined;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new TypeError(`Sample ${sample.sampleId} requires a nonblank evalPrompt`);
  }
  return prompt;
}

export async function evaluateSampling(
  dependencies: EvaluationStageDependencies,
  input: EvaluateSamplingInput,
): Promise<RuntimeEvaluationContext> {
  const evaluatorHarness = requireSpHarness(input.harnessConfig, "evaluator");
  const agentConfig = evaluatorHarness.agentConfig;
  const harnessRuntime = evaluatorHarness.runtime;
  const { sampling, evaluation, sample } = input.context;
  let currentEvaluation = evaluation;
  const retryController = dependencies.createRetryController(input.retryPolicy);
  const persistEvaluation = async (next: EvaluationRecord): Promise<void> => {
    await persistRuntimeRecord({
      record: next,
      expected: currentEvaluation,
      write: (record, expected) => dependencies.store.updateEvaluation(record, expected),
      read: () => dependencies.store.getEvaluation(next.evaluationId),
      retryController,
      sleep: dependencies.sleep,
    });
    currentEvaluation = next;
  };
  const { artifacts, trajectory } = sampling;
  if (
    sampling.execution.status !== "succeeded"
    || artifacts === undefined
    || trajectory === undefined
  ) {
    await persistEvaluation(withEvaluationStatus(currentEvaluation, "failed", "sampling has no successful execution output"));
    return { ...input.context, evaluation: currentEvaluation };
  }

  const subjectChatId = sampling.subjectChatId;
  if (!subjectChatId) {
    await persistEvaluation(withEvaluationStatus(currentEvaluation, "failed", "sampling has no subject Chat"));
    return { ...input.context, evaluation: currentEvaluation };
  }
  // SP creates the Subject Chat under the selected user-agent Config owner.
  const subjectWorkspace = {
    userId: sampling.subjectAgent.ownerUserId,
    chatId: subjectChatId,
  };

  try {
    if (!sample.data || typeof sample.data !== "object" || Array.isArray(sample.data)) {
      throw new AgentOperationError("Sample data must be an object", false, "network");
    }
    const evalPrompt = requireEvaluationPrompt(sample);
    const {
      dataId: _dataId, initialSession: _initialSession,
      userPrompt: _subjectPrompt, evalPrompt: _evalPrompt, ...data
    } = sample.data;
    const parsed = dataInputSchema.safeParse({ ...data, userPrompt: evalPrompt });
    if (!parsed.success) throw new AgentOperationError(parsed.error.message, false, "network");
    const initialData = parsed.data;
    if (currentEvaluation.chatId === undefined && currentEvaluation.attempts.length > 0) {
      throw new AgentOperationError("Cannot resume an Evaluation Attempt without its Chat ID", false, "network");
    }
    const chatId = currentEvaluation.chatId ?? dependencies.idFactory();
    if (currentEvaluation.chatId === undefined) {
      await persistEvaluation({
        ...currentEvaluation,
        evaluator: agentConfig,
        chatId,
      });
    }

    const result = await runAgentLifecycle<EvaluationAttempt, EvaluationAgentOutput>(dependencies, {
      stage: "evaluation",
      role: "evaluator",
      projectId: sampling.projectId,
      samplingId: sampling.samplingId,
      chatId,
      evaluationWorkspace: {
        subject: subjectWorkspace,
        evaluationId: currentEvaluation.evaluationId,
      },
      harnessConfig: evaluatorHarness,
      prompt: evalPrompt,
      retryController,
      attempts: currentEvaluation.attempts,
      createAttempt: ({ attemptId, attemptNumber, startedAt }) => ({
        evaluationAttemptId: attemptId,
        evaluationId: currentEvaluation.evaluationId,
        attemptNumber,
        status: "running",
        startedAt,
      }),
      appendAttempt: async (attempt) => {
        await persistEvaluation({
          ...currentEvaluation,
          attempts: [...currentEvaluation.attempts, attempt],
        });
      },
      updateAttempt: async (attempt, patch) => {
        const existing = currentEvaluation.attempts.find((item) => (
          item.evaluationAttemptId === attempt.evaluationAttemptId
        ));
        if (!existing) throw new Error(`Unknown evaluation attempt ${attempt.evaluationAttemptId}`);
        const updated = applyAttemptPatch(existing, patch);
        await persistEvaluation({
          ...currentEvaluation,
          attempts: currentEvaluation.attempts.map((item) => (
            item.evaluationAttemptId === updated.evaluationAttemptId ? updated : item
          )),
        });
        return updated;
      },
      setSamplingStatus: async (status, lastError) => {
        await persistEvaluation(withEvaluationStatus(currentEvaluation, status, lastError));
      },
      prepare: async (handle) => {
        await dependencies.harness.materializeInitialData({
          handle,
          idempotencyKey: `initial-data:${handle.chatId}`,
          data: initialData,
          ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
        });
        await dependencies.harness.materializeSubjectTrajectory({
          idempotencyKey: `subject-trajectory:${subjectWorkspace.chatId}`,
          samplingId: sampling.samplingId,
          subjectWorkspace,
          trajectory,
        });
      },
      collectOutput: (handle) => dependencies.harness.collectEvaluation({
        handle,
        ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
      }),
      isSuccessfulOutput: (output) => output.status === "succeeded",
      outputFailure: (output) => new AgentOperationError(
        output.error ?? "evaluation output failed",
        true,
        "llm",
      ),
    });

    await persistEvaluation({
      ...currentEvaluation,
      evaluator: agentConfig,
      status: { status: "succeeded" },
      output: result.output,
    });
    return { ...input.context, evaluation: currentEvaluation };
  } catch (error) {
    if (error instanceof RuntimeRecordPersistenceError && error.outcome !== "not-committed") throw error;
    const details = describeAgentError(error);
    const stored = await dependencies.store.getEvaluation(currentEvaluation.evaluationId);
    if (!stored) throw error;
    let failureBase = stored;
    if (error instanceof RuntimeRecordPersistenceError) {
      const expected = error.expectedRecord as EvaluationRecord;
      const attempted = error.attemptedRecord as EvaluationRecord;
      if (sameRuntimeRecordFacts(stored, expected)) {
        const observedAttempt = attempted.attempts.at(-1);
        const savedAttempt = stored.attempts.find((item) => (
          item.evaluationAttemptId === observedAttempt?.evaluationAttemptId
        ));
        if (
          (observedAttempt?.completedAt !== undefined && savedAttempt?.completedAt === undefined)
          || (attempted.output !== undefined && stored.output === undefined)
        ) failureBase = attempted;
      } else if (!sameRuntimeRecordFacts(stored, attempted)) throw error;
    }
    currentEvaluation = stored;
    if (currentEvaluation.status.status === "succeeded") return { ...input.context, evaluation: currentEvaluation };
    await persistEvaluation({
      ...failureBase,
      evaluator: agentConfig,
      status: { status: "failed", lastError: details.message },
    });
    return { ...input.context, evaluation: currentEvaluation };
  }
}

function withEvaluationStatus(
  evaluation: EvaluationRecord,
  status: SamplingStatus,
  lastError?: string,
): EvaluationRecord {
  return {
    ...evaluation,
    status: lastError === undefined ? { status } : { status, lastError },
  };
}
