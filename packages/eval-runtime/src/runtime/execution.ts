import type {
  ExecutionAttempt,
  ExecutionOutput,
  HarnessConfig,
  RetryPolicy,
  Sampling,
} from "@eval-platform/eval-contracts";
import { dataInputSchema } from "@eval-platform/eval-dataset";
import type { AgentHandle } from "../harness/index.js";

import type { RuntimeStore } from "./store.js";
import { RuntimeRecordPersistenceError, persistRuntimeRecord, sameRuntimeRecordFacts } from "./store.js";
import type { RuntimeSamplingContext } from "./model.js";
import type { RetryController } from "./retry.js";
import {
  AgentOperationError,
  ConfirmedSubmissionFailure,
  applyAttemptPatch,
  collectOutputWithRetry,
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
  let observedOutput: ExecutionOutput | undefined;

  const collectEvidence = (chatId: string): Promise<ExecutionOutput> => {
    const handle: AgentHandle = {
      ownerUserId: subjectHarness.agentConfig.ownerUserId,
      chatId,
      samplingId: current.samplingId,
      role: "subject",
      framework: subjectHarness.framework,
    };
    return collectOutputWithRetry({
      stage: "execution",
      retryController,
      sleep: dependencies.sleep,
      collect: () => dependencies.harness.collectExecution({
        handle,
        ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
      }),
    });
  };

  const reportEvidenceError = (error: unknown): void => {
    const reported = new Error(
      `Execution evidence collection failed for Sampling ${current.samplingId}: ${describeAgentError(error).message}`,
      { cause: error },
    );
    try {
      (dependencies.onError ?? console.error)(reported);
    } catch (reportingError) {
      console.error(reported, reportingError);
    }
  };

  const persist = async (sampling: Sampling): Promise<void> => {
    await persistRuntimeRecord({
      record: sampling,
      expected: current,
      write: (record, expected) => dependencies.store.updateSampling(record, expected),
      read: () => dependencies.store.getSampling(sampling.samplingId),
      retryController,
      sleep: dependencies.sleep,
    });
    current = sampling;
  };

  try {
    if (current.execution.evidencePending) {
      const attempt = current.executionAttempts.at(-1);
      if (!current.subjectChatId || !attempt?.submissionId || !attempt.completedAt) {
        throw new AgentOperationError("Pending Subject evidence has no terminal Submission", false, "network");
      }
      let output: ExecutionOutput;
      try {
        output = await collectEvidence(current.subjectChatId);
      } catch (collectionError) {
        reportEvidenceError(collectionError);
        return { state: current, sample };
      }
      const succeeded = attempt.status === "completed" && output.status === "succeeded";
      await persist({
        ...withExecutionStatus(current, succeeded ? "succeeded" : "failed",
          succeeded ? undefined : attempt.error ?? output.error ?? current.execution.lastError ?? "execution failed"),
        artifacts: output.artifacts,
        trajectory: output.trajectory,
      });
      return { state: current, sample };
    }

    if (!sample.data || typeof sample.data !== "object" || Array.isArray(sample.data)) {
      throw new AgentOperationError("Sample data must be an object", false, "network");
    }
    const { dataId: _dataId, evalPrompt: _evalPrompt, evalInitialMaterials: _evalMaterials, ...data } = sample.data;
    const input = dataInputSchema.safeParse(data);
    if (!input.success) throw new AgentOperationError(input.error.message, false, "network");
    const initialData = input.data;
    if (current.subjectChatId === undefined && current.executionAttempts.length > 0) {
      throw new AgentOperationError("Cannot resume an execution Attempt without its Subject Chat ID", false, "network");
    }
    const chatId = current.subjectChatId ?? dependencies.idFactory();
    if (current.subjectChatId === undefined) {
      await persist({ ...current, subjectChatId: chatId });
    }

    const result = await runAgentLifecycle<ExecutionAttempt, ExecutionOutput>(dependencies, {
      stage: "execution",
      role: "subject",
      projectId: current.projectId,
      samplingId: current.samplingId,
      chatId,
      harnessConfig: subjectHarness,
      prompt: initialData.userPrompt,
      retryController,
      attempts: current.executionAttempts,
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
          idempotencyKey: `initial-data:${handle.chatId}`,
          data: initialData,
          ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
        });
      },
      collectOutput: async (handle) => {
        observedOutput = await dependencies.harness.collectExecution({
          handle,
          ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
        });
        return observedOutput;
      },
      isSuccessfulOutput: (output) => output.status === "succeeded",
      outputFailure: (output) => new AgentOperationError(
        output.error ?? "execution output failed",
        true,
        "network",
      ),
      deferFailureStatus: true,
    });

    await persist({
      ...withExecutionStatus(current, "succeeded"),
      artifacts: result.output.artifacts,
      trajectory: result.output.trajectory,
    });
    return { state: current, sample };
  } catch (error) {
    if (error instanceof RuntimeRecordPersistenceError && error.outcome !== "not-committed") throw error;
    const details = describeAgentError(error);
    const stored = await dependencies.store.getSampling(current.samplingId);
    if (!stored) throw error;
    let failureBase = stored;
    if (error instanceof RuntimeRecordPersistenceError) {
      const expected = error.expectedRecord as Sampling;
      const attempted = error.attemptedRecord as Sampling;
      if (sameRuntimeRecordFacts(stored, expected)) {
        const observedAttempt = attempted.executionAttempts.at(-1);
        const savedAttempt = stored.executionAttempts.find((item) => (
          item.executionAttemptId === observedAttempt?.executionAttemptId
        ));
        if (
          (observedAttempt?.completedAt !== undefined && savedAttempt?.completedAt === undefined)
          || (attempted.artifacts !== undefined && stored.artifacts === undefined)
          || (attempted.trajectory !== undefined && stored.trajectory === undefined)
        ) failureBase = attempted;
      } else if (!sameRuntimeRecordFacts(stored, attempted)) throw error;
    }
    current = stored;
    if (current.execution.status === "succeeded") return { state: current, sample };
    const lastAttempt = failureBase.executionAttempts.at(-1);
    const hasTerminalSubmission = !!(failureBase.subjectChatId && lastAttempt?.submissionId && lastAttempt.completedAt
      && (lastAttempt.status === "completed" || lastAttempt.status === "failed"
        || lastAttempt.status === "interrupted" || lastAttempt.status === "cancelled"));
    if (error instanceof RuntimeRecordPersistenceError && hasTerminalSubmission) throw error;
    if (hasTerminalSubmission && lastAttempt?.status !== "completed"
      && !(error instanceof ConfirmedSubmissionFailure)) {
      // A persisted failed Attempt still needs SP calibration and the restart decision.
      // A status outage cannot turn it into final evidence collection.
      throw error;
    }
    if (hasTerminalSubmission && !observedOutput) {
      // Persist the finalization boundary before another read, so a crash cannot restart the Agent.
      await persist({
        ...failureBase,
        execution: { status: "retrying", lastError: lastAttempt?.error ?? details.message, evidencePending: true },
      });
      if (lastAttempt?.status === "completed") return { state: current, sample };
      try {
        observedOutput = await collectEvidence(failureBase.subjectChatId!);
      } catch (collectionError) {
        reportEvidenceError(collectionError);
        return { state: current, sample };
      }
    }
    await persist({
      ...withExecutionStatus(failureBase, "failed", details.message),
      ...(observedOutput === undefined ? {} : {
        artifacts: observedOutput.artifacts,
        trajectory: observedOutput.trajectory,
      }),
    });
    return { state: current, sample };
  }
}
