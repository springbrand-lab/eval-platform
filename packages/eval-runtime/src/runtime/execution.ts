import type {
  ExecutionAttempt,
  ExecutionOutput,
  HarnessConfig,
  RetryPolicy,
  Sampling,
  TrajectoryRef,
} from "@eval-platform/eval-contracts";
import { isTerminalAgentStatus } from "@eval-platform/eval-contracts";
import { dataInputSchema } from "@eval-platform/eval-dataset";
import type { AgentHandle } from "../harness/model.js";

import { persistRuntimeRecord, readStageFailure } from "./store.js";
import { RuntimeRecordPersistenceError } from "./errors.js";
import type { RuntimeSamplingContext } from "./model.js";
import {
  AgentOperationError,
  ConfirmedSubmissionFailure,
  applyAttemptPatch,
  collectOutputWithRetry,
  describeAgentError,
  reportError,
  runAgentLifecycle,
  withExecutionStatus,
  type StageDependencies,
} from "./agent-lifecycle.js";

export interface ExecuteSamplingInput {
  readonly context: RuntimeSamplingContext;
  readonly harnessConfig: HarnessConfig;
  readonly retryPolicy: RetryPolicy;
}

export async function executeSampling(
  dependencies: StageDependencies,
  input: ExecuteSamplingInput,
): Promise<RuntimeSamplingContext> {
  const subjectHarness = input.harnessConfig;
  const harnessRuntime = subjectHarness.runtime;
  const { sample } = input.context;
  let current = input.context.state;
  const retryController = dependencies.createRetryController(input.retryPolicy);
  let observedOutput: ExecutionOutput | undefined;

  const subjectHandle = (chatId: string): AgentHandle => ({
    ownerUserId: subjectHarness.agentConfig.ownerUserId,
    chatId,
    samplingId: current.samplingId,
    role: "subject",
    framework: subjectHarness.framework,
  });

  const collectEvidence = (chatId: string): Promise<ExecutionOutput> => collectOutputWithRetry({
    stage: "execution",
    retryController,
    sleep: dependencies.sleep,
    collect: () => dependencies.harness.collectExecution({
      handle: subjectHandle(chatId),
      ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
    }),
  });

  /**
   * A succeeded execution is evaluable only once its artifacts and complete trajectory are frozen
   * in an evidence bundle; the bundle's trajectory then replaces the framework-local reference.
   * Export shares the execution retry policy; if it never succeeds, the Sampling fails.
   */
  const freezeEvidence = (chatId: string, output: ExecutionOutput): Promise<ExecutionOutput> => collectOutputWithRetry({
    stage: "execution",
    retryController,
    sleep: dependencies.sleep,
    collect: async () => {
      const exported = await dependencies.harness.exportEvidence({
        handle: subjectHandle(chatId),
        limits: dependencies.evidenceLimits,
        ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
      });
      const evidence = await dependencies.evidence.save({ evidence: exported, limits: dependencies.evidenceLimits });
      const { manifest } = await dependencies.evidence.open(evidence);
      const trajectory: TrajectoryRef = {
        trajectoryId: evidence.evidenceId,
        source: "subject",
        path: `evidence:${evidence.evidenceId}/trajectory.jsonl`,
        contentHash: `sha256:${manifest.trajectory.sha256}`,
      };
      return { ...output, trajectory, evidence };
    },
  });

  const reportEvidenceError = (error: unknown): void => {
    const reported = new Error(
      `Execution evidence collection failed for Sampling ${current.samplingId}: ${describeAgentError(error).message}`,
      { cause: error },
    );
    reportError(dependencies.onError, reported);
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
      if (succeeded) {
        try {
          output = await freezeEvidence(current.subjectChatId, output);
        } catch (exportError) {
          await persist({
            ...withExecutionStatus(current, "failed", describeAgentError(exportError).message),
            ...executionEvidence(output),
          });
          return { state: current, sample };
        }
      }
      await persist({
        ...withExecutionStatus(current, succeeded ? "succeeded" : "failed",
          succeeded ? undefined : attempt.error ?? output.error ?? current.execution.lastError ?? "execution failed"),
        ...executionEvidence(output),
      });
      return { state: current, sample };
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

    const frozen = await freezeEvidence(chatId, result.output);
    await persist({
      ...withExecutionStatus(current, "succeeded"),
      ...executionEvidence(frozen),
    });
    return { state: current, sample };
  } catch (error) {
    const details = describeAgentError(error);
    const { stored, failureBase } = await readStageFailure(error, {
      read: () => dependencies.store.getSampling(current.samplingId),
      attempts: (record) => record.executionAttempts,
      attemptId: (attempt) => attempt.executionAttemptId,
      evidence: (record) => [record.artifacts, record.trajectory, record.evidence],
    });
    current = stored;
    if (current.execution.status === "succeeded") return { state: current, sample };
    const lastAttempt = failureBase.executionAttempts.at(-1);
    const terminalChatId = failureBase.subjectChatId && lastAttempt?.submissionId && lastAttempt.completedAt
      && isTerminalAgentStatus(lastAttempt.status) ? failureBase.subjectChatId : undefined;
    if (error instanceof RuntimeRecordPersistenceError && terminalChatId) throw error;
    if (terminalChatId && lastAttempt?.status !== "completed"
      && !(error instanceof ConfirmedSubmissionFailure)) {
      // A persisted failed Attempt still needs SP calibration and the restart decision.
      // A status outage cannot turn it into final evidence collection.
      throw error;
    }
    if (terminalChatId && !observedOutput) {
      // Persist the finalization boundary before another read, so a crash cannot restart the Agent.
      await persist({
        ...failureBase,
        execution: { status: "retrying", lastError: lastAttempt?.error ?? details.message, evidencePending: true },
      });
      if (lastAttempt?.status === "completed") return { state: current, sample };
      try {
        observedOutput = await collectEvidence(terminalChatId);
      } catch (collectionError) {
        reportEvidenceError(collectionError);
        return { state: current, sample };
      }
    }
    await persist({
      ...withExecutionStatus(failureBase, "failed", details.message),
      ...(observedOutput === undefined ? {} : executionEvidence(observedOutput)),
    });
    return { state: current, sample };
  }
}

function executionEvidence(output: ExecutionOutput): Pick<Sampling, "artifacts" | "trajectory" | "evidence"> {
  return {
    artifacts: output.artifacts,
    trajectory: output.trajectory,
    ...(output.evidence === undefined ? {} : { evidence: output.evidence }),
  };
}
