import type {
  EvaluationAgentOutput,
  EvaluationAttempt,
  HarnessConfig,
  RetryPolicy,
  Sampling,
} from "@eval-platform/eval-contracts";

import type { RuntimeSamplingRecord, RuntimeStore } from "./store.js";
import {
  AgentOperationError,
  applyAttemptPatch,
  describeAgentError,
  requireSpAgent,
  runAgentLifecycle,
  withSamplingStatus,
  type AgentLifecycleDependencies,
} from "./agent-lifecycle.js";

export interface EvaluationStageDependencies extends AgentLifecycleDependencies {
  readonly store: RuntimeStore;
}

export interface EvaluateSamplingInput {
  readonly record: RuntimeSamplingRecord;
  readonly harnessConfig: HarnessConfig;
  readonly retryPolicy: RetryPolicy | undefined;
}

export async function evaluateSampling(
  dependencies: EvaluationStageDependencies,
  input: EvaluateSamplingInput,
): Promise<RuntimeSamplingRecord> {
  const agentConfig = requireSpAgent(input.harnessConfig, "evaluator");
  let current = input.record;
  const execution = current.execution;
  if (!execution || execution.status !== "succeeded") {
    return markFailed(current, dependencies.store, "sampling has no successful execution output");
  }

  const subjectSubmissionId = current.sampling.subjectSubmissionId
    ?? latestSubmissionId(current.sampling);
  if (!subjectSubmissionId) {
    return markFailed(current, dependencies.store, "sampling has no subject submission");
  }

  const persist = async (sampling: Sampling): Promise<void> => {
    current = { ...current, sampling };
    await dependencies.store.updateSampling(current);
  };

  try {
    const submissionId = current.sampling.evaluationSubmissionId ?? dependencies.idFactory();
    if (current.sampling.evaluationSubmissionId === undefined) {
      await persist({
        ...current.sampling,
        evaluationAgent: agentConfig,
        evaluationSubmissionId: submissionId,
      });
    }

    const result = await runAgentLifecycle<EvaluationAttempt, EvaluationAgentOutput>(dependencies, {
      stage: "evaluation",
      role: "evaluator",
      projectId: current.sampling.projectId,
      samplingId: current.sampling.samplingId,
      submissionId,
      agentConfig,
      prompt: buildEvaluationPrompt(current.sampling.samplingId),
      retryPolicy: input.retryPolicy,
      createAttempt: ({ attemptId, attemptNumber, startedAt }) => ({
        evaluationAttemptId: attemptId,
        samplingId: current.sampling.samplingId,
        attemptNumber,
        status: "running",
        startedAt,
      }),
      appendAttempt: async (attempt) => {
        await persist({
          ...current.sampling,
          evaluationAttempts: [...current.sampling.evaluationAttempts, attempt],
        });
      },
      updateAttempt: async (attempt, patch) => {
        const updated = applyAttemptPatch(attempt, patch);
        await persist({
          ...current.sampling,
          evaluationAttempts: current.sampling.evaluationAttempts.map((item) => (
            item.evaluationAttemptId === updated.evaluationAttemptId ? updated : item
          )),
        });
        return updated;
      },
      setSamplingStatus: async (status, lastError) => {
        await persist(withSamplingStatus(current.sampling, "evaluation", status, lastError));
      },
      prepare: async (handle) => {
        await dependencies.harness.materializeInitialData({
          handle,
          json: current.sample.json,
          ...(current.sample.initialContext === undefined
            ? {}
            : { initialContext: current.sample.initialContext }),
          ...(current.sample.initialMaterials === undefined
            ? {}
            : { initialMaterials: current.sample.initialMaterials }),
        });
        await dependencies.harness.materializeEvaluationInput({
          samplingId: current.sampling.samplingId,
          subjectSubmissionId,
          evaluationSubmissionId: handle.submissionId,
          artifacts: execution.artifacts,
          trajectory: execution.trajectory,
        });
      },
      collectOutput: (handle) => dependencies.harness.collectEvaluation({ handle }),
      isSuccessfulOutput: (output) => output.status === "succeeded",
      outputFailure: (output) => new AgentOperationError(
        output.error ?? "evaluation output failed",
        true,
        "llm",
      ),
    });

    current = {
      ...current,
      evaluation: result.output,
      sampling: {
        ...withSamplingStatus(current.sampling, "evaluation", "succeeded"),
        evaluationAgent: agentConfig,
      },
    };
    await dependencies.store.updateSampling(current);
    return current;
  } catch (error) {
    const details = describeAgentError(error);
    current = {
      ...current,
      sampling: {
        ...withSamplingStatus(current.sampling, "evaluation", "failed", details.message),
        evaluationAgent: agentConfig,
      },
    };
    await dependencies.store.updateSampling(current);
    return current;
  }
}

function latestSubmissionId(sampling: Sampling): string | undefined {
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

async function markFailed(
  record: RuntimeSamplingRecord,
  store: RuntimeStore,
  reason: string,
): Promise<RuntimeSamplingRecord> {
  const failed = {
    ...record,
    sampling: withSamplingStatus(record.sampling, "evaluation", "failed", reason),
  };
  await store.updateSampling(failed);
  return failed;
}
