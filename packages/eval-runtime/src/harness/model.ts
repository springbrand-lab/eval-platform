import type {
  AgentConfigRef,
  AgentFramework,
  AgentRole,
  AgentResourceReadinessReport,
  AgentResourceSnapshot,
  AgentStatus,
  EvaluationAgentOutput,
  EvaluationOutputSchema,
  EvidenceBundleRef,
  EvidenceExportProgress,
  EvidenceLimits,
  EvidenceManifest,
  EvidenceOmission,
  EvidenceSource,
  ExecutionOutput,
  HarnessConfig,
  MaterializedDataBinding,
  JsonValue,
} from "@eval-platform/eval-contracts";
import type { DataInput, InitialMaterialsRef } from "@eval-platform/eval-dataset";

export type HarnessRuntimeOptions = NonNullable<HarnessConfig["runtime"]>;

/** Stable SP Chat/Session identity; a Submission exists only after dispatch. */
export interface AgentHandle {
  readonly role: AgentRole;
  readonly framework: AgentFramework;
  /** Owner of the Inbox that routes this Chat and its service WebSocket. */
  readonly ownerUserId: string;
  readonly chatId: string;
  readonly samplingId: string;
  /** Only an Evaluator has one; it still owns an ordinary Agent with its own Space. */
  readonly evaluationId?: string;
}

export interface AgentSubmission {
  /** A single prompt submission within the Chat/Session. */
  readonly submissionId: string;
  readonly status: AgentStatus;
  readonly accepted?: boolean;
  readonly createdAt?: number;
  readonly completedAt?: number;
  readonly retryable?: boolean;
  readonly failureKind?: AgentFailureKind;
  readonly error?: string;
}

export const AGENT_FAILURE_KINDS = ["network", "llm", "website", "submission-timeout"] as const;
export type AgentFailureKind = (typeof AGENT_FAILURE_KINDS)[number];

export interface EnsureAgentInput {
  readonly chatId: string;
  readonly role: AgentRole;
  readonly framework: AgentFramework;
  readonly samplingId: string;
  readonly agentConfig: AgentConfigRef;
  readonly projectId: string;
  readonly evaluationId?: string;
  readonly runtime?: HarnessRuntimeOptions;
}

export interface SubmitAgentInput {
  readonly handle: AgentHandle;
  readonly idempotencyKey: string;
  readonly prompt: string;
  readonly runtime?: HarnessRuntimeOptions;
}

export interface InspectAgentOperationInput {
  readonly handle: AgentHandle;
  readonly idempotencyKey: string;
  readonly runtime?: HarnessRuntimeOptions;
}

export interface WaitForSubmissionInput {
  readonly handle: AgentHandle;
  readonly idempotencyKey: string;
  readonly runtime?: HarnessRuntimeOptions;
}

export interface CollectAgentInput {
  readonly handle: AgentHandle;
  readonly runtime?: HarnessRuntimeOptions;
}

export interface CollectAgentResourcesInput {
  readonly handle: AgentHandle;
  readonly idempotencyKey: string;
  /** Omitted only while reconciling a dispatch whose SP receipt is unknown. */
  readonly submissionId?: string;
  readonly runtime?: HarnessRuntimeOptions;
}

export interface MaterializeInitialDataInput {
  readonly handle: AgentHandle;
  readonly idempotencyKey: string;
  readonly data: DataInput;
  /** Required for Evaluators; materialized as a file in their Workspace. */
  readonly evaluationOutputSchema?: EvaluationOutputSchema;
  readonly runtime?: HarnessRuntimeOptions;
}

/** Reads one exported artifact's bytes as a stream. */
export type EvidenceFileReader = (path: string) => Promise<ReadableStream<Uint8Array>>;

/** An artifact as the framework lists it, before its bytes are read and hashed. */
export interface ExportedArtifact {
  readonly path: string;
  readonly size: number;
  readonly mediaType: string;
}

export interface ExportEvidenceInput {
  readonly handle: AgentHandle;
  /** The terminal Subject Submission whose evidence is exported. */
  readonly submissionId: string;
  readonly limits: EvidenceLimits;
  readonly initialMaterials?: readonly InitialMaterialsRef[];
  readonly runtime?: HarnessRuntimeOptions;
}

export interface ExportedSubjectInput extends ExportedArtifact {
  readonly bundleId: string;
  readonly materialId: string;
  read(): Promise<ReadableStream<Uint8Array>>;
}

/** One raw source trajectory event and its strictly increasing, positive source cursor. */
export interface ExportedTrajectoryEvent {
  readonly seq: number;
  /** Written unchanged as one JSONL line. */
  readonly record: JsonValue;
}

/** What one framework exports from a finished Agent; the evidence store freezes it. */
export interface ExportedEvidence {
  readonly source: EvidenceSource;
  /** Already within `limits`; everything left out is listed in `omitted`. */
  readonly artifacts: readonly ExportedArtifact[];
  readonly subjectInputs: readonly ExportedSubjectInput[];
  readonly omitted: readonly EvidenceOmission[];
  readonly readFile: EvidenceFileReader;
  /**
   * Complete raw events after `afterSeq` (0 for all), in order; the adapter pages through its
   * source without projection. Each call starts a new read.
   */
  readTrajectory(afterSeq: number): AsyncIterable<ExportedTrajectoryEvent>;
  readonly trajectoryFormat: string;
  readonly trajectoryComplete: boolean;
  readonly trajectoryIncompleteReason?: string;
}

/** A stored bundle, verified against its reference when opened. */
export interface EvidenceBundleReader {
  readonly ref: EvidenceBundleRef;
  readonly manifest: EvidenceManifest;
  /** The manifest exactly as stored, so every Evaluator reads the same bytes. */
  readonly manifestBytes: Uint8Array;
  readBlob(sha256: string): Promise<ReadableStream<Uint8Array>>;
}

export interface ImportEvidenceInput {
  /** The Evaluator. */
  readonly handle: AgentHandle;
  readonly idempotencyKey: string;
  readonly evidence: EvidenceBundleReader;
  readonly root: "/evidence";
  readonly runtime?: HarnessRuntimeOptions;
}

export interface ResumeEvidenceInput {
  readonly evidence: ExportedEvidence;
  readonly limits: EvidenceLimits;
  /** Progress persisted by an earlier pass of the same export; absent to start one. */
  readonly progress?: EvidenceExportProgress;
  /**
   * Persists progress after each completed step (listing, file, trajectory part); the export
   * waits for it, and a rejection ends the export with that error. Calls never overlap.
   */
  readonly onProgress?: (progress: EvidenceExportProgress) => Promise<void>;
}

/** Content-addressed bundle storage; implemented by the application (R2 or a local directory). */
export interface EvidenceStore {
  /**
   * Stores the listed files and trajectory parts still missing from `progress` by hash, then the
   * manifest; the same progress always finalizes the same manifest, which is written once.
   */
  resume(input: ResumeEvidenceInput): Promise<EvidenceBundleRef>;
  open(ref: EvidenceBundleRef): Promise<EvidenceBundleReader>;
}

export interface Harness {
  ensureAgent(input: EnsureAgentInput): Promise<AgentHandle>;
  materializeInitialData(input: MaterializeInitialDataInput): Promise<MaterializedDataBinding>;
  submitAgent(input: SubmitAgentInput): Promise<AgentSubmission>;
  waitForSubmission(input: WaitForSubmissionInput): Promise<AgentSubmission>;
  inspectAgentOperation(input: InspectAgentOperationInput): Promise<AgentSubmission | null>;
  /**
   * Interrupt every unfinished Submission in this Eval-bound Chat. Resolves once SP has handled
   * the stop, including when nothing was active or the Chat does not exist.
   */
  stopAgent(input: { readonly handle: AgentHandle }): Promise<void>;
  restartAgent(input: SubmitAgentInput): Promise<AgentSubmission>;
  collectExecution(input: CollectAgentInput): Promise<ExecutionOutput>;
  collectEvaluation(input: CollectAgentInput): Promise<EvaluationAgentOutput>;
  /** Text of the Agent's last finished reply in that Submission, or undefined when it has none; read-only. */
  readFinalReply(input: CollectAgentInput & { readonly submissionId: string }): Promise<string | undefined>;
  /** Whether the snapshot is finalized, without downloading its events. */
  inspectAgentResources(input: CollectAgentResourcesInput): Promise<AgentResourceReadinessReport>;
  collectAgentResources(input: CollectAgentResourcesInput): Promise<AgentResourceSnapshot>;
  /** Export a finished Agent's artifacts and complete trajectory; read-only. */
  exportEvidence(input: ExportEvidenceInput): Promise<ExportedEvidence>;
  /** Place a stored bundle into this Agent's own Space under `root`; repeating it is a no-op. */
  importEvidence(input: ImportEvidenceInput): Promise<void>;
}
