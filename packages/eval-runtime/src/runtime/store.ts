import type { EvaluationRecord, RunPhases, Sampling } from "@eval-platform/eval-contracts";
import type { RunConfigSnapshot } from "../config/index.js";
import { describeAgentError } from "./agent-lifecycle.js";
import type { RetryController } from "./retry.js";
import { RuntimeRecordConflictError, RuntimeRecordPersistenceError, type RuntimePersistenceOutcome } from "./record-errors.js";
export { RuntimeRecordConflictError, RuntimeRecordPersistenceError } from "./record-errors.js";

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
}

export interface RuntimeRunAdmission {
  readonly run: RuntimeRunRecord;
  /** False means the Store found and returned the already-created Run. */
  readonly created: boolean;
}

export class RuntimeRunIdentityConflictError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeRunIdentityConflictError";
  }
}

export type SamplingState = Sampling;

export interface RuntimeStore {
  getRun(runId: string): Promise<RuntimeRunRecord | null>;
  /** Persistent Project-scoped lookup used before mutable Config/Sample resolution. */
  findRunByIdempotencyKey(projectId: string, idempotencyKey: string): Promise<RuntimeRunRecord | null>;
  /**
   * Atomically rechecks request identity and commits Run, Sampling, EvaluationRecord and
   * effective-config snapshot data.
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
  listEvaluations(samplingId: string): Promise<readonly EvaluationRecord[]>;
  /** Atomically update only while the supplied previous facts still match. */
  updateSampling(state: SamplingState, expected: SamplingState): Promise<void>;
  getSampling(samplingId: string): Promise<SamplingState | null>;
}

export interface RuntimeRecoveryStore {
  listRecoverableRunIds(afterRunId?: string, limit?: number): Promise<readonly string[]>;
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
      if (sameRuntimeRecordFacts(stored, record)) return;

      const outcome: RuntimePersistenceOutcome = error instanceof RuntimeRecordConflictError
        ? "conflict"
        : readFailed || stored === null
          ? "unknown"
          : !sameRuntimeRecordFacts(stored, expected)
            ? "conflict"
            : "not-committed";
      const details = describeAgentError(error);
      if (outcome === "conflict" || !details.retryable) {
        throw new RuntimeRecordPersistenceError(details.message, outcome, error, record, expected);
      }
      let decision;
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

export function sameRuntimeRecordFacts(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameRuntimeRecordFacts(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => (
      Object.hasOwn(rightRecord, key) && sameRuntimeRecordFacts(leftRecord[key], rightRecord[key])
    ));
}
