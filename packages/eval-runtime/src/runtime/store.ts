import type {
  EvaluationAgentOutput,
  ExecutionOutput,
  RunPhase,
  RunSnapshot,
  Sampling,
} from "@eval-platform/eval-contracts";

import type { Sample } from "./model.js";

export type RuntimePhase = RunPhase;

export interface RuntimeRunRecord extends RunSnapshot {
  readonly phase: RuntimePhase;
}

export interface RuntimeSamplingRecord {
  readonly sampling: Sampling;
  readonly sample: Sample;
  readonly execution?: ExecutionOutput;
  readonly evaluation?: EvaluationAgentOutput;
}

export interface RuntimeStore {
  createRun(record: RuntimeRunRecord): Promise<void>;
  updateRun(record: RuntimeRunRecord): Promise<void>;
  getRun(runId: string): Promise<RuntimeRunRecord | null>;
  createSampling(record: RuntimeSamplingRecord): Promise<void>;
  updateSampling(record: RuntimeSamplingRecord): Promise<void>;
  getSampling(samplingId: string): Promise<RuntimeSamplingRecord | null>;
}
