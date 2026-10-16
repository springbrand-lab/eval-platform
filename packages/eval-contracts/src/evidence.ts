import type { AgentFramework } from "./model.js";

/**
 * An evidence bundle freezes what a Subject produced: its artifacts and its complete trajectory,
 * exported once by the Subject's Harness and imported into any Evaluator's own Space. Evaluation
 * depends only on the bundle, never on where or how the Subject ran.
 */
export const EVIDENCE_SCHEMA_VERSION = 1;

/** Fixed layout of imported evidence inside an Evaluator's Space. */
export const EVIDENCE_ROOT = "/evidence";
export const EVIDENCE_MANIFEST_PATH = "/evidence/manifest.json";
export const EVIDENCE_ARTIFACTS_ROOT = "/evidence/artifacts";
export const EVIDENCE_TRAJECTORY_ROOT = "/evidence/trajectory";
export const EVIDENCE_SUBJECT_INPUTS_ROOT = "/evidence/subject-inputs";
export const EVALUATION_OUTPUT_SCHEMA_PATH = "/evaluation-output.schema.json";
/** Where an Evaluator without the submission tool writes its result, in its own Space. */
export const EVALUATION_RESULT_PATH = "/output/result.json";
/** The Eval MCP tool an Evaluator calls to hand its result to the platform. */
export const EVALUATION_SUBMIT_TOOL = "submit_evaluation";
/** `structuredOutput.path` of a result submitted through that tool or recovered from the final reply. */
export const EVALUATION_SUBMISSION_PATH = "mcp:submit_evaluation";
export const EVALUATION_FINAL_REPLY_PATH = "final-reply";

/** Stored on the Sampling; the bundle itself lives in the evidence store. */
export interface EvidenceBundleRef {
  /** `sha256:<hex>` of the canonical manifest without this field. */
  readonly evidenceId: string;
  /** Lowercase hex SHA-256 of the stored manifest bytes. */
  readonly manifestSha256: string;
  readonly exportedAt: string;
}

export interface EvidenceSource {
  readonly framework: AgentFramework;
  readonly samplingId: string;
  /** Framework-specific locator, kept only for provenance. */
  readonly agentRef: Readonly<Record<string, string>>;
}

export interface EvidenceArtifact {
  readonly path: string;
  readonly size: number;
  readonly mediaType: string;
  /** Lowercase hex SHA-256; the content is stored once per hash. */
  readonly sha256: string;
}

/** The immutable input file, rather than the Subject's possibly modified Workspace copy. */
export interface EvidenceSubjectInput extends EvidenceArtifact {
  readonly bundleId: string;
  readonly materialId: string;
}

export interface EvidenceTrajectoryPart {
  readonly sha256: string;
  readonly size: number;
  readonly events: number;
}

export const EVIDENCE_OMISSION_REASONS = ["excluded", "too-large", "limit"] as const;
export type EvidenceOmissionReason = (typeof EVIDENCE_OMISSION_REASONS)[number];

/** Never dropped silently: an Evaluator reads these to judge how complete the evidence is. */
export interface EvidenceOmission {
  readonly path: string;
  readonly reason: EvidenceOmissionReason;
}

export interface EvidenceManifest {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly evidenceId: string;
  readonly source: EvidenceSource & { readonly exportedAt: string };
  readonly artifacts: readonly EvidenceArtifact[];
  readonly subjectInputs: readonly EvidenceSubjectInput[];
  readonly trajectory: {
    /** The source Harness declares the raw event format; Runtime does not interpret it. */
    readonly format: string;
    readonly parts: readonly EvidenceTrajectoryPart[];
    readonly events: number;
    /** False when the framework could not export its full trajectory; `incompleteReason` says why. */
    readonly complete: boolean;
    readonly incompleteReason?: string;
  };
  readonly omitted: readonly EvidenceOmission[];
}

export interface EvidenceLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
  /** Any artifact with one of these path segments is omitted as `excluded`. */
  readonly excludedSegments: readonly string[];
}

/** SP moves one file per Durable Object RPC, which caps a single file at 25 MB. */
export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = {
  maxFileBytes: 25_000_000,
  maxTotalBytes: 500_000_000,
  maxFiles: 20_000,
  excludedSegments: ["node_modules", ".git", ".cache", ".next", ".turbo", "__pycache__"],
};
