import type { EvaluationRecord, RunPhases, Sampling } from "@eval-platform/eval-contracts";
import { equalJson } from "@springbrand/utils";
import type { RunConfigSnapshot } from "../config/index.js";
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

export interface RuntimeRunRecord {
  readonly runId: string;
  readonly samplingIds: readonly string[];
  readonly projectId: string;
  readonly sourceCommit: string;
  readonly phases: RunPhases;
  readonly evaluationIds: readonly string[];
  /** Immutable effective configuration captured when this Run is admitted. */
  readonly config: RunConfigSnapshot;
  readonly requestIdentity: RuntimeRunRequestIdentity;
  /** Persisted stop intent; omitted until a stop is requested. */
  readonly stopRequested?: true;
  /** Stop cleanup completed; admission may open after all child stages are terminal. */
  readonly stopFinalized?: true;
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
  /** Persistent Project-scoped lookup used before mutable Config/Sample resolution. */
  findRunByIdempotencyKey(projectId: string, idempotencyKey: string): Promise<RuntimeRunRecord | null>;
  /**
   * Atomically rechecks request identity and commits Run, Sampling, EvaluationRecord and
   * effective-config snapshot data. A matching-key replay returns its original Run even
   * while it is active; a new key is rejected if this Project has an unfinished Run.
   * Implementations must use durable uniqueness constraints, not an in-memory map.
   */
  createRunWithSamplings(
    run: RuntimeRunRecord,
    records: readonly SamplingState[],
    evaluations: readonly EvaluationRecord[],
  ): Promise<RuntimeRunAdmission>;
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
