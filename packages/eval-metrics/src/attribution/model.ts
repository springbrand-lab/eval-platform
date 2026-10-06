import type {
  ArtifactRef,
  AttributionResult,
  EvaluationAgentOutput,
  EvaluatorResult,
  TrajectoryRef,
} from "@eval-platform/eval-contracts";

export interface AttributionInput {
  readonly samplingId: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly evaluationOutput: EvaluationAgentOutput;
  readonly evaluatorResults: readonly EvaluatorResult[];
  readonly trajectory: TrajectoryRef;
}

export interface Attributor {
  attribute(input: AttributionInput): Promise<AttributionResult>;
}
