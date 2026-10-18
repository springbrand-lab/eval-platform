import type { EvidenceBundleRef } from "./evidence.js";
import type { AgentResourceCollection } from "./resources.js";

export type {
  AgentResourceCollection,
  AgentResourceCompleteness,
  AgentResourceCoverage,
  AgentResourceFact,
  AgentResourceScope,
  SubmittedAgentResourceScope,
  AgentResourceSnapshot,
} from "./resources.js";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type EvaluationOutputSchema = Readonly<Record<string, JsonValue>>;

export type AgentRole = "subject" | "evaluator";
/** The immutable purpose of an editable Agent Config. */
export type AgentPurpose = "execution" | "evaluation";

export const SAMPLING_STATUSES = ["queued", "starting", "running", "retrying", "succeeded", "failed", "cancelled"] as const;
export type SamplingStatus = (typeof SAMPLING_STATUSES)[number];

/** Statuses that keep a Run unfinished; persistence queries must use this same set. */
export const PENDING_SAMPLING_STATUSES = ["queued", "starting", "running", "retrying"] as const satisfies readonly SamplingStatus[];

export function isPendingSamplingStatus(status: SamplingStatus): boolean {
  return (PENDING_SAMPLING_STATUSES as readonly SamplingStatus[]).includes(status);
}

export interface SamplingStageState {
  readonly status: SamplingStatus;
  readonly lastError?: string;
  /** Subject Submission ended, but artifacts and complete trajectory still need finalization. */
  readonly evidencePending?: boolean;
  /** Explicit collection-only recovery of an already completed Agent; never submit/restart it. */
  readonly collectionPending?: true;
}

export const AGENT_STATUSES = ["queued", "running", "completed", "failed", "interrupted", "cancelled"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const TERMINAL_AGENT_STATUSES = ["completed", "failed", "interrupted", "cancelled"] as const satisfies readonly AgentStatus[];

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return (TERMINAL_AGENT_STATUSES as readonly AgentStatus[]).includes(status);
}

export const EVIDENCE_KINDS = ["artifact", "workspace", "test-report", "trajectory", "evaluation-output", "metric"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const DATASET_KINDS = ["general", "prompt"] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];

/** Project metadata; its plan lives in ProjectPlan and is never edited after creation. */
export interface Project {
  readonly projectId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly description?: string;
  /** SP source branch selected by the Eval deployment that created this Project. */
  readonly sourceBranch: string;
  readonly createdAt: string;
}

export interface AgentConfigRef {
  readonly ownerUserId: string;
  readonly userAgentId: string;
}

export const AGENT_FRAMEWORKS = ["sp", "codex", "cc"] as const;
export type AgentFramework = (typeof AGENT_FRAMEWORKS)[number];

export interface HarnessConfig {
  readonly kind: "sp";
  readonly framework: AgentFramework;
  readonly agentConfig: AgentConfigRef;
  readonly runtime?: {
    readonly timeoutMs?: number;
  };
}

export interface MaterializedDataBinding {
  readonly manifestHash: string;
  readonly target: "workspace";
  readonly materials: readonly {
    readonly bundleId: string;
    readonly materialId: string;
    readonly rootPath: string;
  }[];
  readonly evaluationOutputSchemaPath?: string;
}

export interface ArtifactRef {
  readonly artifactId: string;
  readonly kind: string;
  readonly path: string;
  readonly contentHash?: string;
}

export interface TrajectoryRef {
  readonly trajectoryId: string;
  readonly source: "subject" | "evaluator";
  readonly path: string;
  readonly contentHash?: string;
}

export interface RetryPolicy {
  readonly maxRestarts: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
}

export interface ExecutionAttempt {
  readonly executionAttemptId: string;
  readonly samplingId: string;
  readonly attemptNumber: number;
  readonly submissionId?: string;
  readonly status: AgentStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
  readonly resources?: AgentResourceCollection;
}

export interface EvaluationAttempt {
  readonly evaluationAttemptId: string;
  readonly evaluationId: string;
  readonly attemptNumber: number;
  readonly submissionId?: string;
  readonly status: AgentStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
  readonly resources?: AgentResourceCollection;
}

export interface Sampling {
  readonly samplingId: string;
  readonly projectId: string;
  /** The Project's own fixed input; never live catalog Data. */
  readonly projectSampleId: string;
  readonly execution: SamplingStageState;
  readonly subjectAgent: AgentConfigRef;
  /** SP Chat is the Subject Session; all execution attempts submit within it. */
  readonly subjectChatId?: string;
  readonly executionAttempts: readonly ExecutionAttempt[];
  readonly artifacts?: readonly ArtifactRef[];
  /** Points into the evidence bundle once one was exported. */
  readonly trajectory?: TrajectoryRef;
  /** The frozen artifacts and trajectory every Evaluation of this Sampling reads; absent when not evaluable. */
  readonly evidence?: EvidenceBundleRef;
}

/** Chosen per Run; never persisted on the Project. */
export const RUN_OPERATIONS = ["execution", "pipeline", "evaluation"] as const;
export type RunOperation = (typeof RUN_OPERATIONS)[number];

/**
 * What the user picked. Expansion happens inside the Project snapshot, never the live catalog:
 * `all` and `datasetIds` expand to ProjectSamples; for evaluation every ProjectSample expands
 * further to its current successful Samplings.
 */
export interface RunTargetSelector {
  readonly all?: true;
  readonly datasetIds?: readonly string[];
  readonly projectSampleIds?: readonly string[];
  readonly samplingIds?: readonly string[];
}

/**
 * The fixed, deduplicated result of expanding a selector, returned by preview and submitted unchanged.
 * execution/pipeline: each ProjectSample replaces all its current Samplings with `samplingCount` new ones;
 * each Sampling (whose ProjectSample is not listed) is replaced one-for-one.
 * evaluation: `projectSampleIds` is empty and `samplingIds` lists successful Samplings to re-evaluate.
 */
export interface RunTargets {
  readonly projectSampleIds: readonly string[];
  readonly samplingIds: readonly string[];
}

export interface RunRequest {
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly operation: RunOperation;
  readonly selector: RunTargetSelector;
  readonly targets: RunTargets;
}

export type RunPhase = "execution" | "evaluation";

export type RunPhases =
  | readonly ["execution"]
  | readonly ["evaluation"]
  | readonly ["execution", "evaluation"];

export interface RunHandle {
  readonly runId: string;
  readonly samplingIds: readonly string[];
}

export interface RunSnapshot extends RunHandle {
  /** The Worker is interrupting and finalizing this Run. */
  readonly stopRequested?: true;
  /** Cancellation and evidence collection have been finalized. */
  readonly stopFinalized?: true;
  readonly projectId: string;
  readonly sourceCommit: string;
  readonly operation: RunOperation;
  readonly phases: RunPhases;
  readonly selector: RunTargetSelector;
  readonly targets: RunTargets;
  readonly evaluationIds: readonly string[];
  readonly phase: RunPhase;
  readonly status: SamplingStatus;
}

export interface ExecutionOutput {
  readonly samplingId: string;
  readonly status: "succeeded" | "failed";
  readonly artifacts: readonly ArtifactRef[];
  readonly trajectory: TrajectoryRef;
  /** Set by the runtime after it exported and stored a succeeded Subject's evidence. */
  readonly evidence?: EvidenceBundleRef;
  readonly error?: string;
}

export interface EvidenceRef {
  readonly kind: EvidenceKind;
  readonly ref: string;
  readonly contentHash?: string;
}

/** Where an Evaluator's result came from, in the order Runtime prefers them. */
export const EVALUATION_RESULT_SOURCES = ["submission", "result-file", "final-reply"] as const;
export type EvaluationResultSource = (typeof EVALUATION_RESULT_SOURCES)[number];

/** The Evaluator's raw result, unchanged; Metrics validates it against the Project Schema. */
export interface EvaluationStructuredOutput {
  /** Result file path in the Evaluator's own Space, or the channel the result arrived through. */
  readonly path: string;
  /** Original UTF-8 text, not a parsed copy. */
  readonly content: string;
  readonly contentHash?: string;
  /** Absent on records written before results were submitted directly; those came from the result file. */
  readonly source?: EvaluationResultSource;
}

export interface EvaluationAgentOutput {
  readonly status: "succeeded" | "failed";
  readonly artifacts: readonly ArtifactRef[];
  /** Absent when no result was found; Metrics reports it as unavailable, never as zero. */
  readonly structuredOutput?: EvaluationStructuredOutput;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly trajectory: TrajectoryRef;
  readonly error?: string;
}

/** Where a read-only Chat observation page points; Web never receives a writable Chat URL. */
export interface AgentObservationRef {
  readonly role: AgentRole;
  readonly projectId: string;
  readonly samplingId: string;
  readonly evaluationId?: string;
  /** SP Inbox owner of the Chat. */
  readonly ownerUserId: string;
  /** Absent while the Agent has not been assigned a Chat yet. */
  readonly chatId?: string;
  /** `not-started` until the first Submission; the page then shows an empty, read-only state. */
  readonly state: "not-started" | "available";
}

export interface EvaluationRecord {
  readonly evaluationId: string;
  readonly samplingId: string;
  readonly evaluator: AgentConfigRef;
  /** The Evaluator's SP Chat/Session, distinct from each attempt's Submission. */
  readonly chatId?: string;
  readonly status: SamplingStageState;
  readonly attempts: readonly EvaluationAttempt[];
  readonly output?: EvaluationAgentOutput;
  /** Delivery of the score to the external score store (Langfuse); absent when none is configured. */
  readonly scoreSync?: ScoreSyncState;
}

export interface ScoreSyncState {
  readonly status: "synced" | "failed";
  readonly at: string;
  readonly lastError?: string;
}
