import type { ArtifactRef, EvidenceRef, JsonValue, TrajectoryRef } from "@eval-platform/eval-contracts";

export type NumericSchemaType = "number" | "integer";

export type EvaluationValidationStatus = "valid" | "invalid" | "unavailable";

/**
 * Why a result is valid, invalid or unavailable. `invalid-json` and `unsafe-number` mean the output file
 * exists but can never satisfy a Schema; the other unavailable reasons mean nothing could be validated.
 */
export type EvaluationValidationReason =
  | "valid"
  | "no-output"
  | "no-structured-output"
  | "invalid-json"
  | "unsafe-number"
  | "schema-mismatch"
  | "no-schema"
  | "invalid-schema";

export interface EvaluationValidationError {
  /** JSON Pointer into the output; empty for the whole document. */
  readonly instancePath: string;
  readonly schemaPath: string | null;
  readonly keyword: string;
  readonly message: string;
}

export interface EvaluationValidation {
  readonly status: EvaluationValidationStatus;
  readonly reason: EvaluationValidationReason;
  readonly errors: readonly EvaluationValidationError[];
}

export interface NumericObservation {
  /** Stable field path: object keys as JSON Pointer tokens and every array index as the token `*`. */
  readonly jsonPointer: string;
  /** Exact JSON Pointer of this value, e.g. `/scores/0/value`. */
  readonly instancePointer: string;
  readonly schemaType: NumericSchemaType;
  readonly value: number;
}

/** The Evaluator's result exactly as written, plus how it reads against the Project Schema. */
export interface EvaluationOutputView {
  readonly evaluationId: string;
  readonly samplingId: string;
  readonly outputStatus: "succeeded" | "failed" | null;
  readonly outputError: string | null;
  readonly path: string | null;
  readonly contentHash: string | null;
  /** Original UTF-8 file text. */
  readonly content: string | null;
  /** Strictly parsed `content`; null when absent, malformed or not exactly representable. */
  readonly rawJson: JsonValue | null;
  readonly validation: EvaluationValidation;
  /** Only from valid outputs of succeeded evaluations. */
  readonly numericObservations: readonly NumericObservation[];
  readonly artifacts: readonly ArtifactRef[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly trajectory: TrajectoryRef | null;
}
