import type {
  EvaluationAgentOutput,
  ExecutionOutput,
  RunPhase,
  Sampling,
} from "@eval-platform/eval-contracts";

import type { Sample } from "./model.js";

export type RuntimePhase = RunPhase;

export interface RuntimeRunRecord {
  readonly runId: string;
  readonly samplingIds: readonly string[];
  readonly projectId: string;
  readonly phase: RuntimePhase;
}

export interface RuntimeSamplingRecord {
  readonly sampling: Sampling;
  readonly sample: Sample;
  readonly execution?: ExecutionOutput;
  readonly evaluation?: EvaluationAgentOutput;
}

export interface RuntimeStore {
  getRun(runId: string): Promise<RuntimeRunRecord | null>;
  createRunWithSamplings(
    run: RuntimeRunRecord,
    records: readonly RuntimeSamplingRecord[],
  ): Promise<void>;
  prepareEvaluationSamplings(records: readonly RuntimeSamplingRecord[]): Promise<void>;
  updateSampling(record: RuntimeSamplingRecord): Promise<void>;
  getSampling(samplingId: string): Promise<RuntimeSamplingRecord | null>;
}
