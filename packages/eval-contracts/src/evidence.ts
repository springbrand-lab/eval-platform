import type { AgentFramework, RecoveryPasses } from "./model.js";

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

export interface EvidenceExportArtifact {
  readonly path: string;
  readonly size: number;
  readonly mediaType: string;
  readonly sha256?: string;
}

export interface EvidenceExportSubjectInput extends EvidenceExportArtifact {
  readonly bundleId: string;
  readonly materialId: string;
}

/**
 * The fixed end of a source trajectory read: the source pins it on the first page, and every
 * later page of the same export returns only events with `ingestSeq <= throughSeq`.
 */
export interface EvidenceTrajectoryCursor {
  readonly throughSeq: number;
}

/**
 * What a trajectory export is pinned to. Saved with the progress and handed back to the Harness on
 * a resumed export, so it continues the same read instead of pinning a new one. Both fields are
 * absent in progress saved before pinning existed: that export continues without a cursor.
 */
export interface EvidenceTrajectoryPin {
  readonly format?: string;
  readonly cursor?: EvidenceTrajectoryCursor;
}

/** Every pin field; `satisfies` fails to compile when a field is added to the pin but not here. */
const EVIDENCE_TRAJECTORY_PIN_FIELDS = {
  format: true,
  cursor: true,
} as const satisfies { readonly [Field in keyof Required<EvidenceTrajectoryPin>]: true };

/**
 * Exactly the pin fields of `source` (for example a saved `EvidenceExportProgress.trajectory`),
 * omitting absent ones. Use it wherever a pin is copied, so a new pin field is never dropped.
 */
export function evidenceTrajectoryPinOf(source: EvidenceTrajectoryPin): EvidenceTrajectoryPin {
  const pin: { -readonly [Field in keyof EvidenceTrajectoryPin]: EvidenceTrajectoryPin[Field] } = {};
  for (const field of Object.keys(EVIDENCE_TRAJECTORY_PIN_FIELDS) as (keyof EvidenceTrajectoryPin)[]) {
    const value = source[field];
    if (value !== undefined) Object.assign(pin, { [field]: value });
  }
  return pin;
}

/**
 * Resumable progress of one bundle export. The listing and `exportedAt` are frozen by the first
 * pass, so a resumed export stores only what is missing and finalizes the same manifest.
 */
export interface EvidenceExportProgress {
  readonly exportedAt: string;
  readonly artifacts: readonly EvidenceExportArtifact[];
  readonly subjectInputs: readonly EvidenceExportSubjectInput[];
  readonly omitted: readonly EvidenceOmission[];
  readonly trajectory: EvidenceTrajectoryPin & {
    /** Source cursor after the last event of the last stored part; 0 before any part. */
    readonly afterSeq: number;
    readonly parts: readonly EvidenceTrajectoryPart[];
    readonly done?: true;
  };
}

/** Kept on the Sampling while its Subject evidence export is unfinished, and on its failure. */
export interface EvidenceExportState extends RecoveryPasses {
  /** The Subject Submission the progress belongs to; progress of another Submission is never reused. */
  readonly submissionId: string;
  /** Absent until a pass listed the evidence. */
  readonly progress?: EvidenceExportProgress;
}

/** Runtime passes that may end without a stored bundle before the execution fails. */
export const EVIDENCE_EXPORT_MAX_PASSES = 5;

export interface EvidenceLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
  /** Any artifact with one of these path segments is omitted as `excluded`. */
  readonly excludedSegments: readonly string[];
}

/** SP streams each file in one HTTP request body, which Cloudflare caps at 100 MB. */
export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = {
  maxFileBytes: 95_000_000,
  maxTotalBytes: 500_000_000,
  maxFiles: 20_000,
  excludedSegments: ["node_modules", ".git", ".cache", ".next", ".turbo", "__pycache__"],
};
