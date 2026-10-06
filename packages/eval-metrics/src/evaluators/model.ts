import type {
  ArtifactRef,
  EvaluationAgentOutput,
  EvaluatorResult,
  JsonValue,
  Sampling,
  TrajectoryRef,
} from "@eval-platform/eval-contracts";

export type EvaluatorKind = "artifact" | "trajectory" | "judge";

export interface EvaluatorDefinition {
  readonly evaluatorId: string;
  readonly kind: EvaluatorKind;
}

export interface EvaluatorContext {
  readonly sampling: Sampling;
  readonly artifacts: readonly ArtifactRef[];
  readonly evaluationOutput?: EvaluationAgentOutput;
  readonly subjectOutput?: JsonValue;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly metrics?: Readonly<Record<string, number>>;
  readonly trajectory: TrajectoryRef;
}

export interface Evaluator {
  readonly definition: EvaluatorDefinition;
  evaluate(context: EvaluatorContext): Promise<EvaluatorResult>;
}
