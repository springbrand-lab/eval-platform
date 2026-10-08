import type {
  AgentConfigRef,
  AgentFramework,
  AgentRole,
  AgentResourceSnapshot,
  AgentStatus,
  ArtifactRef,
  EvaluationAgentOutput,
  ExecutionOutput,
  HarnessConfig,
  MaterializedDataBinding,
  TrajectoryRef,
} from "@eval-platform/eval-contracts";
import type { DataInput } from "@eval-platform/eval-dataset";

export type HarnessRuntimeOptions = NonNullable<Extract<
  HarnessConfig,
  { readonly kind: "sp" }
>["runtime"]>;

export interface AgentHandle {
  readonly role: AgentRole;
  readonly framework: AgentFramework;
  readonly submissionId: string;
  readonly samplingId: string;
}

export interface AgentSubmission {
  readonly status: string;
  readonly accepted?: boolean;
  readonly normalizedStatus?: AgentStatus;
  readonly createdAt?: number;
  readonly completedAt?: number;
  readonly retryable?: boolean;
  readonly failureKind?: AgentFailureKind;
  readonly error?: string;
}

export type AgentFailureKind = "network" | "llm" | "website" | "submission-timeout";

export interface EnsureAgentInput {
  readonly submissionId: string;
  readonly role: AgentRole;
  readonly framework: AgentFramework;
  readonly samplingId: string;
  readonly agentConfig: AgentConfigRef;
  readonly projectId: string;
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
  readonly runtime?: HarnessRuntimeOptions;
}

export interface MaterializeInitialDataInput {
  readonly handle: AgentHandle;
  readonly idempotencyKey: string;
  readonly data: DataInput;
  readonly runtime?: HarnessRuntimeOptions;
}

export interface EvaluationInput {
  readonly idempotencyKey: string;
  readonly samplingId: string;
  readonly subjectSubmissionId: string;
  readonly evaluationSubmissionId: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly trajectory: TrajectoryRef;
  readonly runtime?: HarnessRuntimeOptions;
}

export interface Harness {
  ensureAgent(input: EnsureAgentInput): Promise<AgentHandle>;
  materializeInitialData(input: MaterializeInitialDataInput): Promise<MaterializedDataBinding>;
  submitAgent(input: SubmitAgentInput): Promise<AgentSubmission>;
  waitForSubmission(input: WaitForSubmissionInput): Promise<AgentSubmission>;
  inspectAgentOperation(input: InspectAgentOperationInput): Promise<AgentSubmission | null>;
  restartAgent(input: SubmitAgentInput): Promise<AgentSubmission>;
  collectExecution(input: CollectAgentInput): Promise<ExecutionOutput>;
  collectEvaluation(input: CollectAgentInput): Promise<EvaluationAgentOutput>;
  collectAgentResources(input: CollectAgentResourcesInput): Promise<AgentResourceSnapshot>;
  materializeEvaluationInput(input: EvaluationInput): Promise<void>;
}
