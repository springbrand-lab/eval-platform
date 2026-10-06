import type {
  AgentConfigRef,
  AgentRole,
  AgentStatus,
  ArtifactRef,
  EvaluationAgentOutput,
  ExecutionOutput,
  JsonValue,
  MaterializedDataBinding,
  TrajectoryRef,
} from "@eval-platform/eval-contracts";
import type { InitialMaterialsSpec } from "@eval-platform/eval-dataset";

export interface AgentHandle {
  readonly role: AgentRole;
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

export interface StartAgentInput {
  readonly role: AgentRole;
  readonly samplingId: string;
  readonly agentConfig: AgentConfigRef;
  readonly projectId: string;
}

export interface SubmitAgentInput {
  readonly handle: AgentHandle;
  readonly idempotencyKey: string;
  readonly prompt: string;
}

export interface InspectAgentOperationInput {
  readonly handle: AgentHandle;
  readonly idempotencyKey: string;
}

export interface WaitForSubmissionInput {
  readonly handle: AgentHandle;
  readonly idempotencyKey: string;
}

export interface CollectAgentInput {
  readonly handle: AgentHandle;
}

export interface MaterializeInitialDataInput {
  readonly handle: AgentHandle;
  readonly json: JsonValue;
  readonly initialContext?: JsonValue;
  readonly initialMaterials?: InitialMaterialsSpec;
}

export interface EvaluationInput {
  readonly samplingId: string;
  readonly subjectSubmissionId: string;
  readonly evaluationSubmissionId: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly trajectory: TrajectoryRef;
}

export interface Harness {
  startAgent(input: StartAgentInput): Promise<AgentHandle>;
  materializeInitialData(input: MaterializeInitialDataInput): Promise<MaterializedDataBinding>;
  submitAgent(input: SubmitAgentInput): Promise<AgentSubmission>;
  waitForSubmission(input: WaitForSubmissionInput): Promise<AgentSubmission>;
  inspectAgentOperation(input: InspectAgentOperationInput): Promise<AgentSubmission | null>;
  restartAgent(input: SubmitAgentInput): Promise<AgentSubmission>;
  collectExecution(input: CollectAgentInput): Promise<ExecutionOutput>;
  collectEvaluation(input: CollectAgentInput): Promise<EvaluationAgentOutput>;
  materializeEvaluationInput(input: EvaluationInput): Promise<void>;
}
