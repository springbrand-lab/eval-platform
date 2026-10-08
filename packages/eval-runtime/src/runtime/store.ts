import type { EvaluationRecord, RunPhases, Sampling } from "@eval-platform/eval-contracts";
import type { RunConfigSnapshot } from "../config/index.js";
import { describeAgentError } from "./agent-lifecycle.js";
import type { RetryController } from "./retry.js";

export interface RuntimeRunRequestIdentity {
  /** Stable caller identity for one Runtime admission request. */
  readonly requestId: string;
  /** Optional business retry identity that can outlive a transport request. */
  readonly idempotencyKey?: string;
  /** Hash of the immutable facts that define the requested Run. */
  readonly requestFingerprint: string;
}

export interface RuntimeRunRecord {
  readonly runId: string;
  readonly samplingIds: readonly string[];
  readonly projectId: string;
  readonly phases: RunPhases;
  readonly evaluationIds: readonly string[];
  /** Immutable effective configuration captured when this Run is admitted. */
  readonly config: RunConfigSnapshot;
  readonly requestIdentity?: RuntimeRunRequestIdentity;
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
  /** Persistent lookup used before expensive Dataset/Sample preparation. */
  findRunByRequestId(requestId: string): Promise<RuntimeRunRecord | null>;
  findRunByIdempotencyKey(idempotencyKey: string): Promise<RuntimeRunRecord | null>;
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
  updateEvaluation(record: EvaluationRecord): Promise<void>;
  getEvaluation(evaluationId: string): Promise<EvaluationRecord | null>;
  listEvaluations(samplingId: string): Promise<readonly EvaluationRecord[]>;
  updateSampling(state: SamplingState): Promise<void>;
  getSampling(samplingId: string): Promise<SamplingState | null>;
}

export async function persistRuntimeRecord<TRecord extends SamplingState | EvaluationRecord>(input: {
  readonly record: TRecord;
  readonly write: (record: TRecord) => Promise<void>;
  readonly read: () => Promise<TRecord | null>;
  readonly retryController: RetryController;
  readonly sleep: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const record = structuredClone(input.record);
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      await input.write(record);
      return;
    } catch (error) {
      const stored = await Promise.resolve().then(input.read).catch(() => null);
      if (sameRecordFacts(stored, record)) return;

      const details = describeAgentError(error);
      if (!details.retryable) throw error;
      const decision = await input.retryController.decide({
        operation: "persistence",
        failureKind: details.failureKind,
        attemptNumber,
      });
      if (!decision.shouldRetry) throw error;
      await input.sleep(decision.backoffMs ?? 0);
    }
  }
}

function sameRecordFacts(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameRecordFacts(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => (
      Object.hasOwn(rightRecord, key) && sameRecordFacts(leftRecord[key], rightRecord[key])
    ));
}
