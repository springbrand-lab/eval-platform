import type {
  EvaluationAgentOutput,
  EvaluationAttempt,
  EvaluationRecord,
  EvaluationOutputSchema,
  HarnessConfig,
  RetryPolicy,
  SamplingStatus,
} from "@eval-platform/eval-contracts";
import { dataInputSchema } from "@eval-platform/eval-dataset";

import type { ProjectSample, RuntimeEvaluationContext } from "./model.js";
import { persistRuntimeRecord, readStageFailure } from "./store.js";
import { RuntimeAdmissionConflictError } from "./errors.js";
import {
  AgentOperationError,
  applyAttemptPatch,
  describeAgentError,
  reportError,
  runAgentLifecycle,
  type StageDependencies,
} from "./agent-lifecycle.js";
import { publishEvaluationScore, readEvaluationScore } from "./scores.js";

export interface EvaluateSamplingInput {
  readonly context: RuntimeEvaluationContext;
  readonly harnessConfig: HarnessConfig;
  readonly retryPolicy: RetryPolicy;
  readonly evaluationOutputSchema: EvaluationOutputSchema;
}

export function requireEvaluationPrompt(sample: ProjectSample): string {
  const prompt = sample.data.evalPrompt;
  if (prompt === undefined) {
    throw new RuntimeAdmissionConflictError("evaluation-prompt", `ProjectSample ${sample.projectSampleId} has no evalPrompt`);
  }
  return prompt;
}

export async function evaluateSampling(
  dependencies: StageDependencies,
  input: EvaluateSamplingInput,
): Promise<RuntimeEvaluationContext> {
  const evaluatorHarness = input.harnessConfig;
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

  const scoreOf = (output: EvaluationAgentOutput) => (
    readEvaluationScore(output, input.evaluationOutputSchema, dependencies.scores)
  );

  try {
    const evalPrompt = requireEvaluationPrompt(sample);
    const {
      dataId: _dataId, initialSession: _initialSession,
      userPrompt: _subjectPrompt, evalPrompt: _evalPrompt,
      initialMaterials: _subjectMaterials, evalInitialMaterials, ...data
    } = sample.data;
    const parsed = dataInputSchema.safeParse({
      ...data, userPrompt: evalPrompt,
      ...(evalInitialMaterials === undefined ? {} : { initialMaterials: evalInitialMaterials }),
    });
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
          evaluationOutputSchema: input.evaluationOutputSchema,
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

    // The raw result file stays the record of truth (Metrics validates it); only a valid score is synced.
    const scored = scoreOf(result.output);
    await persistEvaluation({
      ...currentEvaluation,
      evaluator: agentConfig,
      status: { status: "succeeded" },
      output: "score" in scored ? { ...result.output, ...scored } : result.output,
    });
    const publish = dependencies.scores?.publish?.bind(dependencies.scores);
    if (publish && "score" in scored) {
      const scoreSync = await publishEvaluationScore(publish, {
        evaluationId: currentEvaluation.evaluationId,
        samplingId: sampling.samplingId,
        projectId: sampling.projectId,
        projectSampleId: sampling.projectSampleId,
        subjectChatId,
        evaluatorChatId: chatId,
        ...scored,
      }, dependencies.now);
      if (scoreSync.lastError !== undefined) {
        reportError(dependencies.onError, new Error(`Evaluation ${currentEvaluation.evaluationId} score was not synced: ${scoreSync.lastError}`));
      }
      await persistEvaluation({ ...currentEvaluation, scoreSync });
    }
    return { ...input.context, evaluation: currentEvaluation };
  } catch (error) {
    const details = describeAgentError(error);
    const { stored, failureBase } = await readStageFailure(error, {
      read: () => dependencies.store.getEvaluation(currentEvaluation.evaluationId),
      attempts: (record) => record.attempts,
      attemptId: (attempt) => attempt.evaluationAttemptId,
      evidence: (record) => [record.output],
    });
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
