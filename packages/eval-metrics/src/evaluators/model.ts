import type {
  AgentConfigRef,
  ArtifactRef,
  EvidenceRef,
  SamplingStageState,
  TrajectoryRef,
} from "@eval-platform/eval-contracts";

export interface EvaluationMetrics {
  readonly evaluationId: string;
  readonly samplingId: string;
  readonly evaluator: AgentConfigRef;
  readonly stage: SamplingStageState;
  readonly outputStatus: "succeeded" | "failed" | null;
  readonly score: {
    readonly status: "available" | "unavailable" | "invalid";
    readonly value: number | null;
  };
  readonly reason: string | null;
  readonly outputError: string | null;
  readonly artifacts: readonly ArtifactRef[];
  readonly trajectory: TrajectoryRef | null;
  readonly evidenceRefs: readonly EvidenceRef[];
}
