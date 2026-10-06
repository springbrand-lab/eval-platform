import type {
  ExecutionAttempt,
  ExecutionOutput,
  HarnessConfig,
  RetryPolicy,
  Sampling,
} from "@eval-platform/eval-contracts";

import type { Harness, MaterializeInitialDataInput } from "../harness/index.js";
import type { RuntimeSamplingRecord, RuntimeStore } from "./store.js";
import type { Sample } from "./model.js";
import {
  AgentOperationError,
  applyAttemptPatch,
  describeAgentError,
  requireSpAgent,
  runAgentLifecycle,
  withSamplingStatus,
  type AgentLifecycleDependencies,
} from "./agent-lifecycle.js";

export interface ExecutionStageDependencies extends AgentLifecycleDependencies {
  readonly store: RuntimeStore;
}

export interface ExecuteSamplingInput {
  readonly record: RuntimeSamplingRecord;
  readonly harnessConfig: HarnessConfig;
  readonly retryPolicy: RetryPolicy | undefined;
}

export async function executeSampling(
  dependencies: ExecutionStageDependencies,
  input: ExecuteSamplingInput,
): Promise<RuntimeSamplingRecord> {
  const agentConfig = requireSpAgent(input.harnessConfig, "subject");
  let current = input.record;

  const persist = async (sampling: Sampling): Promise<void> => {
    current = { ...current, sampling };
    await dependencies.store.updateSampling(current);
  };

  try {
    const submissionId = current.sampling.subjectSubmissionId ?? dependencies.idFactory();
    if (current.sampling.subjectSubmissionId === undefined) {
      await persist({ ...current.sampling, subjectSubmissionId: submissionId });
    }

    const result = await runAgentLifecycle<ExecutionAttempt, ExecutionOutput>(dependencies, {
      stage: "execution",
      role: "subject",
      projectId: current.sampling.projectId,
      samplingId: current.sampling.samplingId,
      submissionId,
      agentConfig,
      prompt: buildExecutionPrompt(current.sample),
      retryPolicy: input.retryPolicy,
      createAttempt: ({ attemptId, attemptNumber, startedAt }) => ({
        executionAttemptId: attemptId,
        samplingId: current.sampling.samplingId,
        attemptNumber,
        status: "running",
        startedAt,
      }),
      appendAttempt: async (attempt) => {
        await persist({
          ...current.sampling,
          executionAttempts: [...current.sampling.executionAttempts, attempt],
        });
      },
      updateAttempt: async (attempt, patch) => {
        const updated = applyAttemptPatch(attempt, patch);
        await persist({
          ...current.sampling,
          executionAttempts: current.sampling.executionAttempts.map((item) => (
            item.executionAttemptId === updated.executionAttemptId ? updated : item
          )),
        });
        return updated;
      },
      setSamplingStatus: async (status, lastError) => {
        await persist(withSamplingStatus(current.sampling, "execution", status, lastError));
      },
      prepare: async (handle) => {
        await dependencies.harness.materializeInitialData(
          materializeInitialDataInput(handle, current.sample),
        );
      },
      collectOutput: (handle) => dependencies.harness.collectExecution({ handle }),
      isSuccessfulOutput: (output) => output.status === "succeeded",
      outputFailure: (output) => new AgentOperationError(
        output.error ?? "execution output failed",
        true,
        "network",
      ),
    });

    current = {
      ...current,
      execution: result.output,
      sampling: {
        ...withSamplingStatus(current.sampling, "execution", "succeeded"),
        artifacts: result.output.artifacts,
        trajectory: result.output.trajectory,
      },
    };
    await dependencies.store.updateSampling(current);
    return current;
  } catch (error) {
    const details = describeAgentError(error);
    current = {
      ...current,
      sampling: withSamplingStatus(current.sampling, "execution", "failed", details.message),
    };
    await dependencies.store.updateSampling(current);
    return current;
  }
}

function materializeInitialDataInput(
  handle: Parameters<Harness["materializeInitialData"]>[0]["handle"],
  sample: Sample,
): MaterializeInitialDataInput {
  return {
    handle,
    json: sample.json,
    ...(sample.initialContext === undefined ? {} : { initialContext: sample.initialContext }),
    ...(sample.initialMaterials === undefined ? {} : { initialMaterials: sample.initialMaterials }),
  };
}

function buildExecutionPrompt(sample: Sample): string {
  return JSON.stringify({
    kind: "eval-execution",
    sampleId: sample.sampleId,
    json: sample.json,
    ...(sample.initialContext === undefined ? {} : { initialContext: sample.initialContext }),
  }, null, 2);
}
