import {
  EVALUATION_RESULT_PATH,
  equalJson,
  EVIDENCE_ARTIFACTS_ROOT,
  EVIDENCE_MANIFEST_PATH,
  EVIDENCE_ROOT,
  EVIDENCE_TRAJECTORY_ROOT,
  EVIDENCE_SUBJECT_INPUTS_ROOT,
  EVALUATION_OUTPUT_SCHEMA_PATH,
  isPendingSamplingStatus,
} from "@eval-platform/eval-contracts";
import type {
  EvaluationAgentOutput,
  EvaluationAttempt,
  EvaluationOutputSchema,
  HarnessConfig,
  RetryPolicy,
  SamplingStatus,
} from "@eval-platform/eval-contracts";
import { dataInputSchema } from "@eval-platform/eval-dataset";

import type { ProjectSample, RuntimeEvaluationContext } from "./model.js";
import { persistRuntimeRecord, readStageFailure, withoutRevision, type AttemptResourceSnapshot, type EvaluationState } from "./store.js";
import { RuntimeAdmissionConflictError, RuntimeRecordPersistenceError } from "./errors.js";
import {
  AgentOperationError,
  SubmissionStatusError,
  applyAttemptPatch,
  collectOutputWithRetry,
  describeAgentError,
  runAgentLifecycle,
  withContext,
  type StageDependencies,
} from "./agent-lifecycle.js";
import { reportError } from "./log.js";
import { evaluationAgentEnded, isAcceptedEvaluation, unconfirmedObservation, withRecoveryBookkeeping } from "./recovery.js";
import { refreshFinishedStage } from "./resource-refresh.js";
import { publishEvaluationScore } from "./scores.js";
import { RESULT_NOT_SUBMITTED, evaluationResultFailure, resolveEvaluationResult, resultInstruction } from "./results.js";

export interface EvaluateSamplingInput {
  readonly context: RuntimeEvaluationContext;
  readonly harnessConfig: HarnessConfig;
  readonly retryPolicy: RetryPolicy;
  readonly evaluationOutputSchema: EvaluationOutputSchema;
}

/** Eval Platform, not the Evaluator's framework, says where evidence is and how the result is handed over. */
export function evaluatorPrompt(
  evalPrompt: string,
  submission?: { readonly evaluationId: string; readonly token: string },
): string {
  return `${evalPrompt}

The evidence to evaluate is in ${EVIDENCE_ROOT}/ of your own Workspace. ${EVIDENCE_MANIFEST_PATH} lists the original Subject inputs, produced artifacts, ordered trajectory parts with sizes and SHA-256 hashes, and any omitted artifacts and why. The original inputs are under ${EVIDENCE_SUBJECT_INPUTS_ROOT}/<bundleId>/<materialId>/ and the produced artifacts are under ${EVIDENCE_ARTIFACTS_ROOT}/ at their original paths. Treat artifacts as the primary evidence and trajectory as supporting evidence. Read every numbered JSONL part under ${EVIDENCE_TRAJECTORY_ROOT}/ in order to see the complete raw Subject trajectory; the manifest declares its source format and completeness. ${resultInstruction({
    schemaPath: EVALUATION_OUTPUT_SCHEMA_PATH,
    resultPath: EVALUATION_RESULT_PATH,
    ...(submission === undefined ? {} : { submission }),
  })}`;
}

export function requireEvaluationPrompt(sample: ProjectSample): string {
  const prompt = sample.data.evalPrompt;
  if (prompt === undefined) {
    throw new RuntimeAdmissionConflictError("evaluation-prompt", `ProjectSample ${sample.projectSampleId} has no evalPrompt`);
  }
  return prompt;
}

export async function evaluateSampling(
  stageDependencies: StageDependencies,
  input: EvaluateSamplingInput,
): Promise<RuntimeEvaluationContext> {
  const { samplingId, evaluationId } = input.context.evaluation;
  const dependencies = withContext(stageDependencies, { stage: "evaluation", samplingId, evaluationId });
  const evaluatorHarness = input.harnessConfig;
  const agentConfig = evaluatorHarness.agentConfig;
  const harnessRuntime = evaluatorHarness.runtime;
  const { sampling, evaluation, sample } = input.context;
  let currentEvaluation = evaluation;
  const retryController = dependencies.createRetryController(input.retryPolicy, dependencies.log);
  const keepAccepted = (next: EvaluationState, accepted: EvaluationState): EvaluationState => {
    if (!isAcceptedEvaluation(accepted) || !accepted.output?.structuredOutput) return next;
    const { error: _error, ...output } = next.output ?? accepted.output;
    // The accepted status stays; only the writer's resource bookkeeping is taken. Observation is moot.
    const { resourcesPending: _resources, observationPending: _observation, ...status } = accepted.status;
    const resourcesPending = next.status.resourcesPending;
    return { ...next, status: { ...status, ...(resourcesPending === undefined ? {} : { resourcesPending }) }, output: {
      ...output, status: "succeeded", structuredOutput: accepted.output.structuredOutput,
    } };
  };
  const withBookkeeping = (record: EvaluationState, previous: EvaluationState): EvaluationState => ({
    ...record, status: withRecoveryBookkeeping(record.status, previous.status, record.attempts, evaluationAgentEnded(record), dependencies),
  });
  const observationFacts = (record: EvaluationState) => {
    const { status: _status, output: _output, ...facts } = withoutRevision(record);
    return facts;
  };
  const write = (next: EvaluationState, expected: EvaluationState, resources?: AttemptResourceSnapshot): Promise<EvaluationState> => persistRuntimeRecord({
    record: next, expected,
    write: (record, previous) => dependencies.store.updateEvaluation(record, previous, resources),
    read: () => dependencies.store.getEvaluation(next.evaluationId), retryController, sleep: dependencies.sleep,
  });
  /** Writes the record prepared against its base, rebasing only onto an accepted result committed meanwhile. */
  const writePrepared = async (prepare: (base: EvaluationState) => EvaluationState, resources?: AttemptResourceSnapshot): Promise<void> => {
    try {
      currentEvaluation = await write(prepare(currentEvaluation), currentEvaluation, resources);
    } catch (error) {
      if (!(error instanceof RuntimeRecordPersistenceError) || error.outcome !== "conflict") throw error;
      const stored = await dependencies.store.getEvaluation(currentEvaluation.evaluationId);
      // Rebase only the API's completion fields; never overwrite concurrent Attempt or stop changes.
      if (!stored || !isAcceptedEvaluation(stored) || !equalJson(observationFacts(stored), observationFacts(currentEvaluation))) throw error;
      currentEvaluation = await write(prepare(stored), stored, resources);
    }
  };
  const persistRecord = (next: EvaluationState, resources?: AttemptResourceSnapshot): Promise<void> => (
    writePrepared((base) => keepAccepted(next, base), resources));
  /** Writes this record with recovery flags derived from the Attempts it commits. */
  const persist = (next: EvaluationState, resources?: AttemptResourceSnapshot): Promise<void> => (
    writePrepared((base) => withBookkeeping(keepAccepted(next, base), base), resources));
  const subjectChatId = sampling.subjectChatId;
  if (currentEvaluation.status.resourcesPending && !isPendingSamplingStatus(currentEvaluation.status.status)) {
    if (currentEvaluation.status.status === "succeeded") await syncScore();
    await refreshFinishedStage(dependencies, {
      stage: "evaluation",
      samplingId: sampling.samplingId,
      handle: currentEvaluation.chatId === undefined ? undefined : {
        ownerUserId: agentConfig.ownerUserId, chatId: currentEvaluation.chatId, samplingId: sampling.samplingId,
        evaluationId: currentEvaluation.evaluationId, role: "evaluator", framework: evaluatorHarness.framework,
      },
      harnessConfig: evaluatorHarness,
      retryController,
      attempts: currentEvaluation.attempts,
      state: currentEvaluation.status,
      agentEnded: evaluationAgentEnded(currentEvaluation),
      persist: (attempts, status, collected) => persistRecord({ ...currentEvaluation, attempts, status },
        collected && { attemptId: collected.attempt.evaluationAttemptId, snapshot: collected.snapshot }),
    });
    return { ...input.context, evaluation: currentEvaluation };
  }
  if (sampling.execution.status !== "succeeded" || sampling.artifacts === undefined || sampling.trajectory === undefined) {
    await persist(withEvaluationStatus(currentEvaluation, "failed", "sampling has no successful execution output"));
    return { ...input.context, evaluation: currentEvaluation };
  }
  const evidenceRef = sampling.evidence;
  if (evidenceRef === undefined) {
    await persist(withEvaluationStatus(currentEvaluation, "failed", "sampling has no evidence bundle"));
    return { ...input.context, evaluation: currentEvaluation };
  }

  // The score is synced to the Subject Chat's session; the Evaluator never touches that Chat.
  if (!subjectChatId) {
    await persist(withEvaluationStatus(currentEvaluation, "failed", "sampling has no subject Chat"));
    return { ...input.context, evaluation: currentEvaluation };
  }

  async function syncScore(): Promise<void> {
    if (currentEvaluation.scoreSync?.status === "synced" || !currentEvaluation.chatId || !subjectChatId) return;
    const publish = dependencies.scores?.publish?.bind(dependencies.scores);
    let scored: ReturnType<NonNullable<typeof dependencies.scores>["read"]>;
    try {
      scored = publish ? dependencies.scores!.read(input.evaluationOutputSchema, currentEvaluation) : undefined;
    } catch (cause) {
      reportError(dependencies.onError, new Error(`Evaluation ${currentEvaluation.evaluationId} score could not be read`, { cause }));
    }
    if (publish && scored) {
      const scoreSync = await publishEvaluationScore(publish, {
        evaluationId: currentEvaluation.evaluationId,
        samplingId: sampling.samplingId,
        projectId: sampling.projectId,
        projectSampleId: sampling.projectSampleId,
        subjectChatId,
        evaluatorChatId: currentEvaluation.chatId!,
        ...scored,
      }, dependencies.now);
      if (scoreSync.lastError !== undefined) {
        reportError(dependencies.onError, new Error(`Evaluation ${currentEvaluation.evaluationId} score was not synced: ${scoreSync.lastError}`));
      }
      // Score delivery must not clear pending terminal receipt or resource recovery.
      await persistRecord({ ...currentEvaluation, scoreSync });
    }
  }

  try {
    if (currentEvaluation.status.collectionPending) {
      const attempt = currentEvaluation.attempts.at(-1);
      if (!currentEvaluation.chatId || attempt?.status !== "completed" || !attempt.submissionId || !attempt.completedAt) throw new AgentOperationError("Only a completed Evaluator can recollect output", false, "network");
    }
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
      await persist({
        ...currentEvaluation,
        evaluator: agentConfig,
        chatId,
      });
    }

    const evaluatorHandle = { ownerUserId: agentConfig.ownerUserId, chatId, samplingId: sampling.samplingId, evaluationId: currentEvaluation.evaluationId, role: "evaluator" as const, framework: evaluatorHarness.framework };
    const results = dependencies.results;
    let finalReply: { submissionId: string; text: string | undefined } | undefined;
    const readFinalReply = async (submissionId: string | undefined): Promise<string | undefined> => {
      if (submissionId === undefined) return undefined;
      if (finalReply?.submissionId === submissionId) return finalReply.text;
      const text = await dependencies.harness.readFinalReply({
        handle: evaluatorHandle, submissionId,
        ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
      });
      finalReply = { submissionId, text };
      return text;
    };
    const resolveOutput = (output: EvaluationAgentOutput): Promise<EvaluationAgentOutput> => results === undefined
      ? Promise.resolve(output) : resolveEvaluationResult({
        port: results, evaluationId: currentEvaluation.evaluationId, output,
        readFinalReply: () => readFinalReply(currentEvaluation.attempts.at(-1)?.submissionId),
      });
    const recollect = async () => {
      const output = await collectOutputWithRetry({ stage: "evaluation", retryController, sleep: dependencies.sleep,
        collect: async () => resolveOutput(await dependencies.harness.collectEvaluation({ handle: evaluatorHandle })),
      });
      if (output.status !== "succeeded") throw new AgentOperationError(`evaluation output collection failed: ${output.error ?? "output unavailable"}`, false, "network");
      return { output };
    };
    const submissionToken = dependencies.results?.submission?.token(currentEvaluation.evaluationId);
    const result = currentEvaluation.status.collectionPending ? await recollect() : await runAgentLifecycle<EvaluationAttempt, EvaluationAgentOutput>(dependencies, {
      stage: "evaluation",
      deferFailureStatus: dependencies.results?.submission !== undefined,
      role: "evaluator",
      projectId: sampling.projectId,
      samplingId: sampling.samplingId,
      chatId,
      evaluationId: currentEvaluation.evaluationId,
      harnessConfig: evaluatorHarness,
      prompt: () => submissionToken !== undefined && currentEvaluation.attempts.some((attempt) => (
        attempt.status === "completed" && attempt.error === RESULT_NOT_SUBMITTED
      ))
        ? "Please complete the evaluation, then use the MCP tool to submit the evaluation result."
        : evaluatorPrompt(evalPrompt, submissionToken === undefined ? undefined
          : { evaluationId: currentEvaluation.evaluationId, token: submissionToken }),
      retryController: {
        async decide(request) {
          if (request.operation === "restart") {
            // The MCP transaction may accept a result while the Agent's terminal
            // receipt is still being observed. Re-read the authoritative record
            // before creating another Attempt; the local snapshot can be stale.
            try {
              const latest = await dependencies.store.getEvaluation(currentEvaluation.evaluationId);
              if (latest && isAcceptedEvaluation(latest)) {
                currentEvaluation = latest;
                return { shouldRetry: false };
              }
            } catch {
              // Keep the normal retry decision when the reconciliation read is unavailable.
            }
          }
          return retryController.decide(request);
        },
      },
      attempts: currentEvaluation.attempts,
      attemptId: (attempt) => attempt.evaluationAttemptId,
      createAttempt: ({ attemptId, attemptNumber, startedAt }) => ({
        evaluationAttemptId: attemptId,
        evaluationId: currentEvaluation.evaluationId,
        attemptNumber,
        status: "running",
        startedAt,
      }),
      appendAttempt: async (attempt) => {
        await persist({
          ...currentEvaluation,
          attempts: [...currentEvaluation.attempts, attempt],
        });
      },
      updateAttempt: async (attempt, patch, snapshot) => {
        const existing = currentEvaluation.attempts.find((item) => (
          item.evaluationAttemptId === attempt.evaluationAttemptId
        ));
        if (!existing) throw new Error(`Unknown evaluation attempt ${attempt.evaluationAttemptId}`);
        const updated = applyAttemptPatch(existing, patch);
        await persist({
          ...currentEvaluation,
          attempts: currentEvaluation.attempts.map((item) => (
            item.evaluationAttemptId === updated.evaluationAttemptId ? updated : item
          )),
        }, snapshot && { attemptId: updated.evaluationAttemptId, snapshot });
        return updated;
      },
      setSamplingStatus: async (status, lastError) => {
        await persist(withEvaluationStatus(currentEvaluation, status, lastError));
      },
      prepare: async (handle) => {
        await dependencies.harness.materializeInitialData({
          handle,
          idempotencyKey: `initial-data:${handle.chatId}`,
          data: initialData,
          evaluationOutputSchema: input.evaluationOutputSchema,
          ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
        });
        await dependencies.harness.importEvidence({
          handle,
          idempotencyKey: `evidence:${evidenceRef.evidenceId}:${currentEvaluation.evaluationId}`,
          evidence: await dependencies.evidence.open(evidenceRef),
          root: EVIDENCE_ROOT,
          ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
        });
      },
      collectOutput: async (handle) => resolveOutput(await dependencies.harness.collectEvaluation({
        handle,
        ...(harnessRuntime === undefined ? {} : { runtime: harnessRuntime }),
      })),
      recoverOutput: async (_handle, output) => {
        if (!results || output.structuredOutput || dependencies.finalizingStop || dependencies.runStopped) return undefined;
        return new AgentOperationError(RESULT_NOT_SUBMITTED, true, "llm");
      },
      isSuccessfulOutput: (output) => output.status === "succeeded",
      outputFailure: (output) => new AgentOperationError(
        output.error ?? "evaluation output failed",
        true,
        "llm",
      ),
    });

    // Recheck acceptance after the lifecycle: missing or invalid results never count as success.
    const output = results === undefined ? result.output : await collectOutputWithRetry({
      stage: "evaluation", retryController, sleep: dependencies.sleep,
      collect: () => resolveOutput(result.output),
    });
    const resultFailure = results === undefined ? undefined : evaluationResultFailure(results, input.evaluationOutputSchema, output);
    if (resultFailure !== undefined) {
      await persist({
        ...currentEvaluation,
        evaluator: agentConfig,
        status: { status: "failed", lastError: resultFailure },
        output,
      });
      return { ...input.context, evaluation: currentEvaluation };
    }
    // The raw result stays the record of truth (Metrics validates it); only a valid score is synced.
    await persist({
      ...currentEvaluation,
      evaluator: agentConfig,
      status: { status: "succeeded" },
      output,
    });
    await syncScore();
    return { ...input.context, evaluation: currentEvaluation };
  } catch (error) {
    // MCP may have committed while this worker was observing SP or writing stale Attempt facts.
    const accepted = await dependencies.store.getEvaluation(currentEvaluation.evaluationId);
    if (accepted && isAcceptedEvaluation(accepted)) {
      currentEvaluation = accepted;
      // Observation loss after acceptance is not a failure; the unread resources become a refresh.
      const settled = withBookkeeping(accepted, accepted);
      if (!equalJson(settled, accepted)) await persistRecord(settled);
      await syncScore();
      return { ...input.context, evaluation: currentEvaluation };
    }
    const details = describeAgentError(error);
    const { stored, failureBase } = await readStageFailure(error, {
      read: () => dependencies.store.getEvaluation(currentEvaluation.evaluationId),
      attempts: (record) => record.attempts,
      attemptId: (attempt) => attempt.evaluationAttemptId,
      evidence: (record) => [record.output],
    });
    currentEvaluation = stored;
    if (currentEvaluation.status.status === "succeeded") return { ...input.context, evaluation: currentEvaluation };
    const lastAttempt = failureBase.attempts.at(-1);
    if (error instanceof SubmissionStatusError && lastAttempt && lastAttempt.completedAt === undefined) {
      await persist({ ...failureBase, evaluator: agentConfig, status: unconfirmedObservation("evaluation", failureBase.status, details.message) });
      return { ...input.context, evaluation: currentEvaluation };
    }
    await persist({
      ...failureBase,
      evaluator: agentConfig,
      status: { status: dependencies.results?.submission && error instanceof SubmissionStatusError ? "retrying" : "failed", lastError: details.message },
    });
    return { ...input.context, evaluation: currentEvaluation };
  }
}

function withEvaluationStatus(
  evaluation: EvaluationState,
  status: SamplingStatus,
  lastError?: string,
): EvaluationState {
  return {
    ...evaluation,
    status: lastError === undefined ? { status } : { status, lastError },
  };
}
