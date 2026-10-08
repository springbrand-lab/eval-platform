import type { EvaluationRecord, RunPhases, Sampling } from "@eval-platform/eval-contracts";
import type { RunConfigSnapshot } from "../config/index.js";

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
