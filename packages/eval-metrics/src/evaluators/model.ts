import type {
  AgentResourceCompleteness,
  ArtifactRef,
  EvaluationOutputSchemaRef,
  EvidenceRef,
  JsonValue,
  TrajectoryRef,
} from "@eval-platform/eval-contracts";
import type { NumericSummary } from "../aggregation/model.js";

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

export type NumericMissingReason = "not-succeeded" | "invalid-output" | "unavailable-output" | "absent";

export interface NumericObservationSummary {
  readonly jsonPointer: string;
  readonly schemaType: NumericSchemaType;
  /** Values; an array field can yield several per evaluation. */
  readonly observationCount: number;
  readonly contributingEvaluationCount: number;
  readonly missingEvaluationCount: number;
  readonly summary: NumericSummary;
  readonly coverage: AgentResourceCompleteness;
  /** Why evaluations in scope did not contribute; only non-zero reasons. */
  readonly diagnostics: readonly { readonly reason: NumericMissingReason; readonly evaluations: number }[];
}

export interface NumericOutputSummary {
  /** The locked Project Schema; null without an evaluation plan. */
  readonly schema: EvaluationOutputSchemaRef | null;
  readonly coverage: AgentResourceCompleteness;
  readonly evaluations: number;
  readonly validation: Readonly<Record<EvaluationValidationStatus, number>>;
  /** Schema-declared numeric fields in Schema order, then observed fields the static walk cannot name (map keys, recursion). */
  readonly fields: readonly NumericObservationSummary[];
}
