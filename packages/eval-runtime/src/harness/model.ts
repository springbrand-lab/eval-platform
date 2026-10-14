import type {
  AgentConfigRef,
  AgentFramework,
  AgentRole,
  AgentResourceSnapshot,
  AgentStatus,
  EvaluationAgentOutput,
  EvaluationOutputSchema,
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

/** The SP SpaceDO locator for the Subject Chat's Workspace. */
export interface SubjectWorkspaceRef {
  readonly userId: string;
  readonly chatId: string;
}

/** An Evaluator owns its Chat but writes only to its directory in this Workspace. */
export interface EvaluationWorkspaceBinding {
  readonly subject: SubjectWorkspaceRef;
  readonly evaluationId: string;
}

/** Stable SP Chat/Session identity; a Submission exists only after dispatch. */
export interface AgentHandle {
  readonly role: AgentRole;
  readonly framework: AgentFramework;
  /** Owner of the Inbox that routes this Chat and its service WebSocket. */
  readonly ownerUserId: string;
  readonly chatId: string;
  readonly samplingId: string;
  readonly evaluationWorkspace?: EvaluationWorkspaceBinding;
}

export interface AgentSubmission {
  /** A single prompt submission within the Chat/Session. */
  readonly submissionId: string;
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
  readonly chatId: string;
  readonly role: AgentRole;
  readonly framework: AgentFramework;
  readonly samplingId: string;
  readonly agentConfig: AgentConfigRef;
  readonly projectId: string;
  readonly evaluationWorkspace?: EvaluationWorkspaceBinding;
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

export interface SubjectTrajectoryMaterializationInput {
  readonly idempotencyKey: string;
  readonly samplingId: string;
  readonly subjectWorkspace: SubjectWorkspaceRef;
  readonly trajectory: TrajectoryRef;
}

export interface Harness {
  ensureAgent(input: EnsureAgentInput): Promise<AgentHandle>;
  materializeInitialData(input: MaterializeInitialDataInput): Promise<MaterializedDataBinding>;
  submitAgent(input: SubmitAgentInput): Promise<AgentSubmission>;
  waitForSubmission(input: WaitForSubmissionInput): Promise<AgentSubmission>;
  inspectAgentOperation(input: InspectAgentOperationInput): Promise<AgentSubmission | null>;
  /** Interrupt every unfinished Submission in this Eval-bound Chat. */
  stopAgent(input: { readonly handle: AgentHandle }): Promise<boolean>;
  restartAgent(input: SubmitAgentInput): Promise<AgentSubmission>;
  collectExecution(input: CollectAgentInput): Promise<ExecutionOutput>;
  collectEvaluation(input: CollectAgentInput): Promise<EvaluationAgentOutput>;
  collectAgentResources(input: CollectAgentResourcesInput): Promise<AgentResourceSnapshot>;
  materializeSubjectTrajectory(input: SubjectTrajectoryMaterializationInput): Promise<void>;
}
