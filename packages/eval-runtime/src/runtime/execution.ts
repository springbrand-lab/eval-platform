import type {
  EvidenceExportProgress,
  EvidenceExportState,
  ExecutionAttempt,
  ExecutionOutput,
  HarnessConfig,
  RecoveryPasses,
  RetryPolicy,
  Sampling,
  TrajectoryRef,
} from "@eval-platform/eval-contracts";
import {
  EVIDENCE_EXPORT_MAX_PASSES,
  isPendingSamplingStatus,
  isTerminalAgentStatus,
} from "@eval-platform/eval-contracts";
import { dataInputSchema } from "@eval-platform/eval-dataset";
import type { AgentHandle } from "../harness/model.js";

import { persistRuntimeRecord, readStageFailure, type AttemptResourceSnapshot, type SamplingState } from "./store.js";
import { RuntimeRecordPersistenceError, RuntimeRunStoppedError } from "./errors.js";
import type { RuntimeSamplingContext } from "./model.js";
import {
  AgentOperationError,
  ConfirmedSubmissionFailure,
  SubmissionStatusError,
  applyAttemptPatch,
  collectOutputWithRetry,
  describeAgentError,
  runAgentLifecycle,
  withContext,
  withExecutionStatus,
  type StageDependencies,
} from "./agent-lifecycle.js";
import { reportError } from "./log.js";
import { executionAgentEnded, failedPass, unconfirmedObservation, withRecoveryBookkeeping } from "./recovery.js";
import { refreshFinishedStage } from "./resource-refresh.js";

const EVIDENCE_EXPORT_FAILED = "evidence export failed";

export interface ExecuteSamplingInput {
  readonly context: RuntimeSamplingContext;
  readonly harnessConfig: HarnessConfig;
  readonly retryPolicy: RetryPolicy;
}

export async function executeSampling(
  stageDependencies: StageDependencies,
  input: ExecuteSamplingInput,
): Promise<RuntimeSamplingContext> {
  const dependencies = withContext(stageDependencies, { stage: "execution", samplingId: input.context.state.samplingId });
  const subjectHarness = input.harnessConfig;
  const harnessRuntime = subjectHarness.runtime;
  const { sample } = input.context;
  let current = input.context.state;
  const retryController = dependencies.createRetryController(input.retryPolicy, dependencies.log);
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

  /** Saved export progress of exactly this Submission; progress of any other Submission is never reused. */
  const exportStateOf = (submissionId: string): EvidenceExportState | undefined => (
    current.evidenceExport?.submissionId === submissionId ? current.evidenceExport : undefined
  );

  /**
   * A succeeded execution is evaluable only once its artifacts and complete trajectory are frozen
   * in an evidence bundle; the bundle's trajectory then replaces the framework-local reference.
   * Each stored file and trajectory part is saved as progress first, so a retry reads only what is missing.
   */
  const freezeEvidence = (chatId: string, output: ExecutionOutput, submissionId: string, passes: number): Promise<ExecutionOutput> => (
    collectOutputWithRetry({
      stage: "execution",
      retryController,
      sleep: dependencies.sleep,
      failureLabel: EVIDENCE_EXPORT_FAILED,
      collect: async () => {
        const exported = await dependencies.harness.exportEvidence({
          handle: subjectHandle(chatId),
          submissionId,
          limits: dependencies.evidenceLimits,
          ...(sample.data.initialMaterials === undefined ? {} : { initialMaterials: sample.data.initialMaterials }),
          ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
        });
        const progress = exportStateOf(submissionId)?.progress;
        const evidence = await dependencies.evidence.resume({
          evidence: exported,
          limits: dependencies.evidenceLimits,
          ...(progress === undefined ? {} : { progress }),
          onProgress: (next) => {
            const { lastError } = exportStateOf(submissionId) ?? {};
            return persist({ ...current, evidenceExport: { submissionId, passes, ...(lastError === undefined ? {} : { lastError }), progress: next } });
          },
        });
        const trajectory: TrajectoryRef = {
          trajectoryId: evidence.evidenceId,
          source: "subject",
          path: `evidence:${evidence.evidenceId}/trajectory/`,
          contentHash: `sha256:${evidence.manifestSha256}`,
        };
        return { ...output, trajectory, evidence };
      },
    })
  );

  const reportEvidenceError = (error: unknown): void => {
    const reported = new Error(
      `Execution evidence collection failed for Sampling ${current.samplingId}: ${describeAgentError(error).message}`,
      { cause: error },
    );
    reportError(dependencies.onError, reported);
  };

  const persistRecord = async (sampling: SamplingState, resources?: AttemptResourceSnapshot): Promise<void> => {
    current = await persistRuntimeRecord({
      record: sampling,
      expected: current,
      write: (record, expected) => dependencies.store.updateSampling(record, expected, resources),
      read: () => dependencies.store.getSampling(sampling.samplingId),
      retryController,
      sleep: dependencies.sleep,
    });
  };
  /** Writes this record with recovery flags derived from the Attempts it commits. */
  const persist = (sampling: SamplingState, resources?: AttemptResourceSnapshot): Promise<void> => persistRecord({
    ...sampling,
    execution: withRecoveryBookkeeping(
      sampling.execution, current.execution, sampling.executionAttempts, executionAgentEnded, dependencies,
    ),
  }, resources);

  /**
   * Ends one pass without a bundle, keeping the output and export progress. A transient failure
   * keeps the execution pending until `EVIDENCE_EXPORT_MAX_PASSES` passes failed; the Subject
   * Agent is never resubmitted or restarted for an export failure.
   */
  const persistEvidenceExportFailure = async (output: ExecutionOutput, error: unknown, submissionId: string,
    previous: RecoveryPasses | undefined): Promise<void> => {
    const details = describeAgentError(error);
    const { next, exhausted } = failedPass(previous, details.message, EVIDENCE_EXPORT_MAX_PASSES);
    const { progress } = exportStateOf(submissionId) ?? {};
    const evidenceExport: EvidenceExportState = { submissionId, ...next, ...(progress === undefined ? {} : { progress }) };
    if (details.retryable && !exhausted) {
      await persist({
        ...current,
        execution: { status: "retrying", lastError: details.message, evidencePending: true },
        ...executionEvidence(output),
        evidenceExport,
      });
      return;
    }
    const cause = error instanceof AgentOperationError && error.cause !== undefined ? describeAgentError(error.cause).message : details.message;
    await persist({
      ...withExecutionStatus(current, "failed", details.retryable
        ? `${EVIDENCE_EXPORT_FAILED} after ${next.passes} passes: ${cause}` : details.message),
      ...executionEvidence(output),
      evidenceExport,
    });
  };

  const freezeEvidenceOrPersistFailure = async (
    chatId: string,
    output: ExecutionOutput,
    submissionId: string | undefined,
  ): Promise<ExecutionOutput | undefined> => {
    if (submissionId === undefined) {
      throw new AgentOperationError("Subject evidence has no terminal Submission", false, "network");
    }
    // A manual recollection starts a fresh pass budget on the same progress.
    const previous = current.execution.collectionPending ? undefined : exportStateOf(submissionId);
    const started = Date.now();
    const logExport = (outcome: "stored" | "failed", error?: unknown) => dependencies.log({
      name: "evidence_export", submissionId, passes: (previous?.passes ?? 0) + 1, outcome,
      ...exportSummary(exportStateOf(submissionId)?.progress), durationMs: Date.now() - started,
      ...(error === undefined ? {} : { error: describeAgentError(error).message }),
    });
    try {
      const frozen = await freezeEvidence(chatId, output, submissionId, previous?.passes ?? 0);
      logExport("stored");
      return frozen;
    } catch (error) {
      if (error instanceof RuntimeRecordPersistenceError || error instanceof RuntimeRunStoppedError) throw error;
      logExport("failed", error);
      await persistEvidenceExportFailure(output, error, submissionId, previous);
      return undefined;
    }
  };

  if (current.execution.resourcesPending && !isPendingSamplingStatus(current.execution.status)) {
    await refreshFinishedStage(dependencies, {
      stage: "execution",
      samplingId: current.samplingId,
      handle: current.subjectChatId === undefined ? undefined : subjectHandle(current.subjectChatId),
      harnessConfig: subjectHarness,
      retryController,
      attempts: current.executionAttempts,
      state: current.execution,
      agentEnded: executionAgentEnded,
      persist: (executionAttempts, execution, collected) => persistRecord({ ...current, executionAttempts, execution },
        collected && { attemptId: collected.attempt.executionAttemptId, snapshot: collected.snapshot }),
    });
    return { state: current, sample };
  }

  try {
    if (current.execution.evidencePending || current.execution.collectionPending) {
      const attempt = current.executionAttempts.at(-1);
      if (!current.subjectChatId || !attempt?.submissionId || !attempt.completedAt) {
        throw new AgentOperationError("Pending Subject evidence has no terminal Submission", false, "network");
      }
      if (current.execution.collectionPending && attempt.status !== "completed") throw new AgentOperationError("Only a completed Subject can recollect output", false, "network");
      let output: ExecutionOutput;
      try {
        output = await collectEvidence(current.subjectChatId);
      } catch (collectionError) {
        reportEvidenceError(collectionError);
        if (current.execution.collectionPending) await persist(withExecutionStatus(current, "failed", `execution output collection failed: ${describeAgentError(collectionError).message}`));
        return { state: current, sample };
      }
      const succeeded = attempt.status === "completed" && output.status === "succeeded";
      if (succeeded) {
        const frozen = await freezeEvidenceOrPersistFailure(current.subjectChatId, output, attempt.submissionId);
        if (frozen === undefined) return { state: current, sample };
        output = frozen;
      }
      await persist({
        ...withExecutionStatus(withoutEvidenceExport(current), succeeded ? "succeeded" : "failed",
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
      attemptId: (attempt) => attempt.executionAttemptId,
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
      updateAttempt: async (attempt, patch, snapshot) => {
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
        }, snapshot && { attemptId: updated.executionAttemptId, snapshot });
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

    if (dependencies.finalizingStop) {
      await persist({ ...current, execution: { status: "retrying", evidencePending: true }, ...executionEvidence(result.output) });
      return { state: current, sample };
    }
    const frozen = await freezeEvidenceOrPersistFailure(chatId, result.output, current.executionAttempts.at(-1)?.submissionId);
    if (frozen === undefined) return { state: current, sample };
    await persist({
      ...withExecutionStatus(withoutEvidenceExport(current), "succeeded"),
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
    if (error instanceof SubmissionStatusError && lastAttempt && lastAttempt.completedAt === undefined) {
      await persist({ ...failureBase, execution: unconfirmedObservation("execution", failureBase.execution, details.message) });
      return { state: current, sample };
    }
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

/** Counts and sizes of one export's saved progress; never paths or bytes. */
function exportSummary(progress: EvidenceExportProgress | undefined): Record<string, unknown> {
  if (progress === undefined) return {};
  const files = [...progress.artifacts, ...progress.subjectInputs];
  const stored = files.filter((file) => file.sha256 !== undefined);
  const { parts } = progress.trajectory;
  const omitted: Record<string, number> = {};
  for (const { reason } of progress.omitted) omitted[reason] = (omitted[reason] ?? 0) + 1;
  return {
    filesStored: stored.length,
    filesTotal: files.length,
    bytes: [...stored, ...parts].reduce((sum, { size }) => sum + size, 0),
    trajectoryParts: parts.length,
    trajectoryRecords: parts.reduce((sum, { records }) => sum + records, 0),
    trajectoryDone: progress.trajectory.done === true,
    omitted,
  };
}

/** Once the bundle is stored, its reference replaces the export progress. */
function withoutEvidenceExport(sampling: SamplingState): SamplingState {
  const { evidenceExport: _progress, ...rest } = sampling;
  return rest;
}

function executionEvidence(output: ExecutionOutput): Pick<Sampling, "artifacts" | "trajectory" | "evidence"> {
  return {
    artifacts: output.artifacts,
    trajectory: output.trajectory,
    ...(output.evidence === undefined ? {} : { evidence: output.evidence }),
  };
}
