import type {
  EvaluationAgentOutput,
  EvaluationAttempt,
  EvaluationRecord,
  HarnessConfig,
  RetryPolicy,
  SamplingStatus,
} from "@eval-platform/eval-contracts";
import { dataInputSchema } from "@eval-platform/eval-dataset";

import type { RuntimeEvaluationContext } from "./model.js";
import type { RuntimeStore } from "./store.js";
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
}

export interface EvaluateSamplingInput {
  readonly context: RuntimeEvaluationContext;
  readonly harnessConfig: HarnessConfig;
  readonly retryPolicy: RetryPolicy;
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
  const { artifacts, trajectory } = sampling;
  if (
    sampling.execution.status !== "succeeded"
    || artifacts === undefined
    || trajectory === undefined
  ) {
    return {
      ...input.context,
      evaluation: await markFailed(
        currentEvaluation,
        dependencies.store,
        "sampling has no successful execution output",
      ),
    };
  }

  const subjectSubmissionId = sampling.subjectSubmissionId
    ?? latestSubmissionId(sampling);
  if (!subjectSubmissionId) {
    return {
      ...input.context,
      evaluation: await markFailed(
        currentEvaluation,
        dependencies.store,
        "sampling has no subject submission",
      ),
    };
  }

  const persistEvaluation = async (next: EvaluationRecord): Promise<void> => {
    currentEvaluation = next;
    await dependencies.store.updateEvaluation(next);
  };

  try {
    const { dataId: _dataId, initialSession: _initialSession, ...data } = sample.data;
    const initialData = dataInputSchema.parse(data);
    const submissionId = currentEvaluation.submissionId ?? dependencies.idFactory();
    if (currentEvaluation.submissionId === undefined) {
      await persistEvaluation({
        ...currentEvaluation,
        evaluator: agentConfig,
        submissionId,
      });
    }

    const result = await runAgentLifecycle<EvaluationAttempt, EvaluationAgentOutput>(dependencies, {
      stage: "evaluation",
      role: "evaluator",
      projectId: sampling.projectId,
      samplingId: sampling.samplingId,
      submissionId,
      harnessConfig: evaluatorHarness,
      prompt: buildEvaluationPrompt(sampling.samplingId),
      retryPolicy: input.retryPolicy,
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
          idempotencyKey: `initial-data:${handle.submissionId}`,
          data: initialData,
          ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
        });
        await dependencies.harness.materializeEvaluationInput({
          idempotencyKey: `evaluation-input:${handle.submissionId}`,
          samplingId: sampling.samplingId,
          subjectSubmissionId,
          evaluationSubmissionId: handle.submissionId,
          artifacts,
          trajectory,
          ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
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

    currentEvaluation = {
      ...currentEvaluation,
      evaluator: agentConfig,
      status: { status: "succeeded" },
      output: result.output,
    };
    await dependencies.store.updateEvaluation(currentEvaluation);
    return { ...input.context, evaluation: currentEvaluation };
  } catch (error) {
    const details = describeAgentError(error);
    currentEvaluation = {
      ...currentEvaluation,
      evaluator: agentConfig,
      status: { status: "failed", lastError: details.message },
    };
    await dependencies.store.updateEvaluation(currentEvaluation);
    return { ...input.context, evaluation: currentEvaluation };
  }
}

function latestSubmissionId(
  sampling: RuntimeEvaluationContext["sampling"],
): string | undefined {
  for (let index = sampling.executionAttempts.length - 1; index >= 0; index -= 1) {
    const submissionId = sampling.executionAttempts[index]?.submissionId;
    if (submissionId) return submissionId;
  }
  return undefined;
}

function buildEvaluationPrompt(samplingId: string): string {
  return JSON.stringify({
    kind: "eval-evaluation",
    samplingId,
    instruction: "Evaluate the subject agent's artifacts. The artifacts and complete trajectory are available in the current workspace.",
  }, null, 2);
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

async function markFailed(
  record: EvaluationRecord,
  store: RuntimeStore,
  reason: string,
): Promise<EvaluationRecord> {
  const failed = withEvaluationStatus(record, "failed", reason);
  await store.updateEvaluation(failed);
  return failed;
}
