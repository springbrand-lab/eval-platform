import type {
  ExecutionAttempt,
  ExecutionOutput,
  HarnessConfig,
  RetryPolicy,
  Sampling,
} from "@eval-platform/eval-contracts";
import { dataInputSchema } from "@eval-platform/eval-dataset";

import type { RuntimeStore } from "./store.js";
import { persistRuntimeRecord } from "./store.js";
import type { RuntimeSamplingContext } from "./model.js";
import type { RetryController } from "./retry.js";
import {
  AgentOperationError,
  applyAttemptPatch,
  describeAgentError,
  requireSpHarness,
  runAgentLifecycle,
  withExecutionStatus,
  type AgentLifecycleDependencies,
} from "./agent-lifecycle.js";

export interface ExecutionStageDependencies extends AgentLifecycleDependencies {
  readonly store: RuntimeStore;
  readonly createRetryController: (policy?: RetryPolicy) => RetryController;
}

export interface ExecuteSamplingInput {
  readonly context: RuntimeSamplingContext;
  readonly harnessConfig: HarnessConfig;
  readonly retryPolicy: RetryPolicy;
}

export async function executeSampling(
  dependencies: ExecutionStageDependencies,
  input: ExecuteSamplingInput,
): Promise<RuntimeSamplingContext> {
  const subjectHarness = requireSpHarness(input.harnessConfig, "subject");
  const harnessRuntime = subjectHarness.runtime;
  const { sample } = input.context;
  let current = input.context.state;
  const retryController = dependencies.createRetryController(input.retryPolicy);

  const persist = async (sampling: Sampling): Promise<void> => {
    current = sampling;
    await persistRuntimeRecord({
      record: current,
      write: (record) => dependencies.store.updateSampling(record),
      read: () => dependencies.store.getSampling(sampling.samplingId),
      retryController,
      sleep: dependencies.sleep,
    });
  };

  try {
    const { dataId: _dataId, ...data } = sample.data;
    const initialData = dataInputSchema.parse(data);
    const submissionId = current.subjectSubmissionId ?? dependencies.idFactory();
    if (current.subjectSubmissionId === undefined) {
      await persist({ ...current, subjectSubmissionId: submissionId });
    }

    const result = await runAgentLifecycle<ExecutionAttempt, ExecutionOutput>(dependencies, {
      stage: "execution",
      role: "subject",
      projectId: current.projectId,
      samplingId: current.samplingId,
      submissionId,
      harnessConfig: subjectHarness,
      prompt: initialData.userPrompt,
      retryController,
      createAttempt: ({ attemptId, attemptNumber, startedAt }) => ({
        executionAttemptId: attemptId,
        samplingId: current.samplingId,
        attemptNumber,
        status: "running",
        startedAt,
      }),
      appendAttempt: async (attempt) => {
        await persist({
          ...current,
          executionAttempts: [...current.executionAttempts, attempt],
        });
      },
      updateAttempt: async (attempt, patch) => {
        const existing = current.executionAttempts.find((item) => (
          item.executionAttemptId === attempt.executionAttemptId
        ));
        if (!existing) throw new Error(`Unknown execution attempt ${attempt.executionAttemptId}`);
        const updated = applyAttemptPatch(existing, patch);
        await persist({
          ...current,
          executionAttempts: current.executionAttempts.map((item) => (
            item.executionAttemptId === updated.executionAttemptId ? updated : item
          )),
        });
        return updated;
      },
      setSamplingStatus: async (status, lastError) => {
        await persist(withExecutionStatus(current, status, lastError));
      },
      prepare: async (handle) => {
        await dependencies.harness.materializeInitialData({
          handle,
          idempotencyKey: `initial-data:${handle.submissionId}`,
          data: initialData,
          ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
        });
      },
      collectOutput: (handle) => dependencies.harness.collectExecution({
        handle,
        ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
      }),
      isSuccessfulOutput: (output) => output.status === "succeeded",
      outputFailure: (output) => new AgentOperationError(
        output.error ?? "execution output failed",
        true,
        "network",
      ),
    });

    await persist({
      ...withExecutionStatus(current, "succeeded"),
      artifacts: result.output.artifacts,
      trajectory: result.output.trajectory,
    });
    return { state: current, sample };
  } catch (error) {
    const details = describeAgentError(error);
    await persist(withExecutionStatus(current, "failed", details.message));
    return { state: current, sample };
  }
}
