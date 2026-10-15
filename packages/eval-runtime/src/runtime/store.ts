import type {
  EvaluationRecord,
  RunOperation,
  RunPhases,
  RunTargetSelector,
  RunTargets,
  Sampling,
} from "@eval-platform/eval-contracts";
import { equalJson } from "@springbrand/utils";
import { describeAgentError } from "./agent-lifecycle.js";
import type { RetryController, RetryDecision } from "./retry.js";
import {
  RuntimeRecordConflictError,
  RuntimeRecordPersistenceError,
  RuntimeRunStoppedError,
  type RuntimePersistenceOutcome,
} from "./errors.js";

export interface RuntimeRunRequestIdentity {
  /** Stable caller intent within one Project, reused on retries. */
  readonly idempotencyKey: string;
  /** Hash of the immutable facts that define the requested Run. */
  readonly requestFingerprint: string;
}

/** Plan digests a Run was admitted against; the Run stores no configuration body. */
export interface RuntimeRunPlanDigests {
  readonly execution: string;
  /** Present for pipeline/evaluation Runs. */
  readonly evaluation?: string;
}

export interface RuntimeRunRecord {
  readonly runId: string;
  readonly projectId: string;
  readonly sourceCommit: string;
  readonly operation: RunOperation;
  /** Derived from operation: execution, evaluation, or execution then evaluation. */
  readonly phases: RunPhases;
  readonly selector: RunTargetSelector;
  readonly targets: RunTargets;
  /** execution/pipeline: the new Samplings; evaluation: the selected existing Samplings. */
  readonly samplingIds: readonly string[];
  /** The new EvaluationRecords, one per Sampling for pipeline/evaluation. */
  readonly evaluationIds: readonly string[];
  readonly planDigests: RuntimeRunPlanDigests;
  readonly requestIdentity: RuntimeRunRequestIdentity;
  /** Persisted stop intent; omitted until a stop is requested. */
  readonly stopRequested?: true;
  /** Stop cleanup completed; admission may open after all child stages are terminal. */
  readonly stopFinalized?: true;
}

/** Everything one admission transaction replaces and inserts. */
export interface RuntimeRunAdmissionCommand {
  readonly run: RuntimeRunRecord;
  /**
   * execution/pipeline: every current Sampling of `run.targets.projectSampleIds` plus
   * `run.targets.samplingIds`, as read before the transaction; empty for evaluation.
   */
  readonly replacedSamplingIds: readonly string[];
  /** New Samplings (execution/pipeline only). */
  readonly samplings: readonly SamplingState[];
  /** New EvaluationRecords (pipeline/evaluation only). */
  readonly evaluations: readonly EvaluationRecord[];
}

export interface RuntimeRunAdmission {
  readonly run: RuntimeRunRecord;
  /** False means the Store found and returned the already-created Run. */
  readonly created: boolean;
}

export type SamplingState = Sampling;

export interface RuntimeStore {
  getRun(runId: string): Promise<RuntimeRunRecord | null>;
  /** Serialize the start of remote stage mutations with a saved stop request. */
  withRunDispatchGate<T>(runId: string, dispatch: () => Promise<T>): Promise<T>;
  /** Persistent Project-scoped lookup used before reading the plan or current Samplings. */
  findRunByIdempotencyKey(projectId: string, idempotencyKey: string): Promise<RuntimeRunRecord | null>;
  /** Current Samplings of these ProjectSamples, grouped in input order, each group ordered by samplingId. */
  listProjectSamplings(projectId: string, projectSampleIds: readonly string[]): Promise<readonly SamplingState[]>;
  /**
   * One transaction under the Project row lock. It must:
   * - reject a missing or soft-deleted Project, and a source-release mismatch for user Stores;
   * - replay the Run of a matching key (same fingerprint) even while active, reject a different
   *   fingerprint and a key whose Run a later Run superseded, then reject a new key while the
   *   Project has an active Run;
   * - refuse a Run carrying the Project's creation key once the Project has any Run
   *   (`creation-superseded`);
   * - recheck `run.planDigests` against the current plan, and for pipeline/evaluation require an
   *   evaluation plan (else `evaluation-plan-required`);
   * - recheck that `replacedSamplingIds` equals the current Sampling set of the targets (else
   *   `stale-targets`), and for evaluation that every target Sampling still succeeded;
   * - delete replaced Samplings with their EvaluationRecords and Run memberships, or for evaluation
   *   only the targets' current EvaluationRecords; never touch unselected records;
   * - insert the Run with the next Project sequence, its Samplings, EvaluationRecords and memberships
   *   in SQL batches;
   * - lock the evaluation plan for the first pipeline/evaluation Run, then enqueue the Worker job.
   * A durable unique (project, idempotency key) constraint and the Run sequence, not process memory,
   * enforce identity.
   */
  admitRun(command: RuntimeRunAdmissionCommand): Promise<RuntimeRunAdmission>;
  /** Atomically update only while the supplied previous facts still match. */
  updateEvaluation(record: EvaluationRecord, expected: EvaluationRecord): Promise<void>;
  getEvaluation(evaluationId: string): Promise<EvaluationRecord | null>;
  /** Return one Evaluation or null per input ID, in the same order. */
  getEvaluations(evaluationIds: readonly string[]): Promise<readonly (EvaluationRecord | null)[]>;
  listEvaluations(samplingId: string): Promise<readonly EvaluationRecord[]>;
  /** Atomically update only while the supplied previous facts still match. */
  updateSampling(state: SamplingState, expected: SamplingState): Promise<void>;
  getSampling(samplingId: string): Promise<SamplingState | null>;
  /** Return one Sampling or null per input ID, in the same order. */
  getSamplings(samplingIds: readonly string[]): Promise<readonly (SamplingState | null)[]>;
}

export interface RuntimeRecoveryStore {
  /** True while a stage is unfinished or a stop request is not yet finalized. */
  isRunActive(runId: string): Promise<boolean>;
  isRunStopRequested(runId: string): Promise<boolean>;
  /** Persist a system stop for an active Run whose scheduling budget is exhausted. */
  requestRunStop(runId: string): Promise<void>;
  markRunStopFinalized(runId: string): Promise<boolean>;
}

export async function persistRuntimeRecord<TRecord extends SamplingState | EvaluationRecord>(input: {
  readonly record: TRecord;
  readonly expected: TRecord;
  readonly write: (record: TRecord, expected: TRecord) => Promise<void>;
  readonly read: () => Promise<TRecord | null>;
  readonly retryController: RetryController;
  readonly sleep: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const record = structuredClone(input.record);
  const expected = structuredClone(input.expected);
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      await input.write(record, expected);
      return;
    } catch (error) {
      let stored: TRecord | null = null;
      let readFailed = false;
      try {
        stored = await input.read();
      } catch {
        readFailed = true;
      }
      if (equalJson(stored, record)) return;

      const outcome: RuntimePersistenceOutcome = error instanceof RuntimeRecordConflictError
        ? "conflict"
        : readFailed || stored === null
          ? "unknown"
          : !equalJson(stored, expected)
            ? "conflict"
            : "not-committed";
      const details = describeAgentError(error);
      if (outcome === "conflict" || !details.retryable) {
        throw new RuntimeRecordPersistenceError(details.message, outcome, error, record, expected);
      }
      let decision: RetryDecision;
      try {
        decision = await input.retryController.decide({
          operation: "persistence",
          failureKind: details.failureKind,
          attemptNumber,
        });
      } catch (decisionError) {
        throw new RuntimeRecordPersistenceError(
          "Persistence retry decision failed: " + describeAgentError(decisionError).message,
          outcome,
          decisionError,
          record,
          expected,
        );
      }
      if (!decision.shouldRetry) {
        throw new RuntimeRecordPersistenceError(details.message, outcome, error, record, expected);
      }
      try {
        await input.sleep(decision.backoffMs ?? 0);
      } catch (sleepError) {
        throw new RuntimeRecordPersistenceError(
          "Persistence retry delay failed: " + describeAgentError(sleepError).message,
          outcome,
          sleepError,
          record,
          expected,
        );
      }
    }
  }
}

/** A stage record reread after its stage failed. */
export interface StageFailureRecords<TRecord> {
  /** The record as committed. */
  readonly stored: TRecord;
  /** The record the failure write extends: the attempted one when it carries Agent facts the Store never saved. */
  readonly failureBase: TRecord;
}

/**
 * Rereads a stage record after `error` and rethrows the errors a failure write must not mask:
 * Run stops, committed or conflicting persistence, and a record changed by another writer.
 */
export async function readStageFailure<
  TRecord extends SamplingState | EvaluationRecord,
  TAttempt extends { readonly completedAt?: string },
>(error: unknown, record: {
  readonly read: () => Promise<TRecord | null>;
  readonly attempts: (record: TRecord) => readonly TAttempt[];
  readonly attemptId: (attempt: TAttempt) => string;
  /** Agent evidence fields, in a fixed order. */
  readonly evidence: (record: TRecord) => readonly unknown[];
}): Promise<StageFailureRecords<TRecord>> {
  if (error instanceof RuntimeRunStoppedError) throw error;
  if (error instanceof RuntimeRecordPersistenceError && error.outcome !== "not-committed") throw error;
  const stored = await record.read();
  if (!stored) throw error;
  if (!(error instanceof RuntimeRecordPersistenceError)) return { stored, failureBase: stored };
  const attempted = error.attemptedRecord as TRecord;
  if (!equalJson(stored, error.expectedRecord)) {
    if (equalJson(stored, attempted)) return { stored, failureBase: stored };
    throw error;
  }
  const observedAttempt = record.attempts(attempted).at(-1);
  const savedAttempt = observedAttempt && record.attempts(stored).find((attempt) => (
    record.attemptId(attempt) === record.attemptId(observedAttempt)
  ));
  const storedEvidence = record.evidence(stored);
  const unsaved = (observedAttempt?.completedAt !== undefined && savedAttempt?.completedAt === undefined)
    || record.evidence(attempted).some((value, index) => value !== undefined && storedEvidence[index] === undefined);
  return { stored, failureBase: unsaved ? attempted : stored };
}
