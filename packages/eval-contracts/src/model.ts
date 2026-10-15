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
}

export const AGENT_STATUSES = ["queued", "running", "completed", "failed", "interrupted", "cancelled"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const TERMINAL_AGENT_STATUSES = ["completed", "failed", "interrupted", "cancelled"] as const satisfies readonly AgentStatus[];

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return (TERMINAL_AGENT_STATUSES as readonly AgentStatus[]).includes(status);
}

export type EvidenceKind =
  | "artifact"
  | "workspace"
  | "test-report"
  | "trajectory"
  | "judge-output"
  | "metric";

export interface Project {
  readonly projectId: string;
  readonly ownerUserId: string;
  readonly name: string;
  /** SP source branch selected by the Eval deployment that created this Project. */
  readonly sourceBranch: string;
  /** Selected standalone output format; fixed after the first Evaluation Run. */
  readonly evaluationOutputSchemaId?: string;
  /** Fixed by the first admitted Run; an empty Project has no initial launch yet. */
  readonly initialLaunch?: ProjectInitialLaunch;
}

export interface ProjectInitialLaunch {
  readonly operation: "execution" | "pipeline";
  readonly configId: string;
}

export interface AgentConfigRef {
  readonly ownerUserId: string;
  readonly userAgentId: string;
}

export const AGENT_FRAMEWORKS = ["sp", "codex", "cc"] as const;
export type AgentFramework = (typeof AGENT_FRAMEWORKS)[number];

export interface SpHarnessConfig {
  readonly kind: "sp";
  readonly framework: AgentFramework;
  readonly agentConfig: AgentConfigRef;
  readonly runtime?: {
    readonly timeoutMs?: number;
  };
}

export interface RemoteHarnessConfig {
  readonly kind: "remote";
  readonly provider: string;
  readonly agentRef: string;
  readonly runOptions?: Readonly<Record<string, JsonValue>>;
}

export type HarnessConfig = SpHarnessConfig | RemoteHarnessConfig;

export interface MaterializedDataBinding {
  readonly bundleId: string;
  readonly manifestHash: string;
  readonly target: "workspace" | "sandbox";
  readonly rootPath: string;
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
  readonly sampleId: string;
  readonly execution: SamplingStageState;
  readonly subjectAgent: AgentConfigRef;
  /** SP Chat is the Subject Session; all execution attempts submit within it. */
  readonly subjectChatId?: string;
  readonly executionAttempts: readonly ExecutionAttempt[];
  readonly artifacts?: readonly ArtifactRef[];
  readonly trajectory?: TrajectoryRef;
}

export interface StartRunRequest {
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly executionConfigId: string;
}

export interface EvaluateRequest {
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly samplingIds: readonly string[];
  readonly evaluationConfigId: string;
}

export interface PipelineRequest {
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly pipelineConfigId: string;
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
  readonly phases: RunPhases;
  readonly evaluationIds: readonly string[];
  readonly phase: RunPhase;
  readonly status: SamplingStatus;
}

export interface ExecutionOutput {
  readonly samplingId: string;
  readonly status: "succeeded" | "failed";
  readonly artifacts: readonly ArtifactRef[];
  readonly trajectory: TrajectoryRef;
  readonly error?: string;
}

export interface EvidenceRef {
  readonly kind: EvidenceKind;
  readonly ref: string;
  readonly contentHash?: string;
}

export interface EvaluationAgentOutput {
  readonly status: "succeeded" | "failed";
  readonly artifacts: readonly ArtifactRef[];
  readonly score?: number;
  readonly reason?: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly trajectory: TrajectoryRef;
  readonly error?: string;
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
}
