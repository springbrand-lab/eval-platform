export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type AgentRole = "subject" | "evaluator";

export type SamplingStatus =
  | "queued"
  | "starting"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AgentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export type EvaluatorResultStatus = "passed" | "failed" | "error" | "skipped";

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
}

export interface AgentConfigRef {
  readonly ownerUserId: string;
  readonly userAgentId: string;
}

export interface SpHarnessConfig {
  readonly kind: "sp";
  readonly agentConfig: AgentConfigRef;
  readonly runtime?: {
    readonly workspaceMode?: "isolated" | "shared-readonly";
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
}

export interface EvaluationAttempt {
  readonly evaluationAttemptId: string;
  readonly samplingId: string;
  readonly attemptNumber: number;
  readonly submissionId?: string;
  readonly status: AgentStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface Sampling {
  readonly samplingId: string;
  readonly projectId: string;
  readonly sampleId: string;
  readonly status: SamplingStatus;
  readonly subjectAgent: AgentConfigRef;
  readonly subjectSubmissionId?: string;
  readonly evaluationAgent?: AgentConfigRef;
  readonly evaluationSubmissionId?: string;
  readonly executionAttempts: readonly ExecutionAttempt[];
  readonly evaluationAttempts: readonly EvaluationAttempt[];
  readonly artifacts?: readonly ArtifactRef[];
  readonly trajectory?: TrajectoryRef;
  readonly lastError?: string;
}

export interface StartRunRequest {
  readonly projectId: string;
  readonly datasetId: string;
  readonly sampleIds?: readonly string[];
  readonly samplingCount: number;
  readonly executionConcurrency: number;
  readonly harness: HarnessConfig;
  readonly retryPolicy?: RetryPolicy;
}

export interface EvaluateRequest {
  readonly projectId: string;
  readonly samplingIds: readonly string[];
  readonly evaluationHarness: HarnessConfig;
  readonly evaluationConcurrency: number;
  readonly retryPolicy?: RetryPolicy;
}

export interface PipelineRequest extends StartRunRequest {
  readonly evaluationHarness: HarnessConfig;
  readonly evaluationConcurrency: number;
}

export type RunPhase = "execution" | "evaluation" | "pipeline";

export interface RunHandle {
  readonly runId: string;
  readonly samplingIds: readonly string[];
}

export interface RunSnapshot extends RunHandle {
  readonly projectId: string;
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

export interface EvaluatorResult {
  readonly evaluatorId: string;
  readonly status: EvaluatorResultStatus;
  readonly score?: number;
  readonly details?: JsonValue;
}

export interface AttributionResult {
  readonly category: string;
  readonly confidence?: number;
  readonly explanation: string;
  readonly evidenceRefs: readonly EvidenceRef[];
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

export interface EvaluationResult {
  readonly sampleId: string;
  readonly samplingId: string;
  readonly evaluatorResults: readonly EvaluatorResult[];
  readonly attribution?: AttributionResult;
  readonly evidenceRefs: readonly EvidenceRef[];
}
