export type {
  AgentFailureKind,
  AgentHandle,
  AgentSubmission,
  CollectAgentInput,
  CollectAgentResourcesInput,
  EnsureAgentInput,
  EvaluationWorkspaceBinding,
  Harness,
  HarnessRuntimeOptions,
  InspectAgentOperationInput,
  MaterializeInitialDataInput,
  SubmitAgentInput,
  SubjectTrajectoryMaterializationInput,
  SubjectWorkspaceRef,
  WaitForSubmissionInput,
} from "./model.js";
export { AGENT_FAILURE_KINDS } from "./model.js";

export class AgentIdentityConflictError extends Error {
  readonly retryable = false;

  constructor(readonly chatId: string) {
    super(`Chat identity ${chatId} is already bound to different creation facts`);
    this.name = "AgentIdentityConflictError";
  }
}

/** The persisted Chat handle no longer resolves through the public SP seam. */
export class AgentHandleNotFoundError extends Error {
  readonly retryable = false;

  constructor(readonly chatId: string) {
    super(`Chat ${chatId} was not found`);
    this.name = "AgentHandleNotFoundError";
  }
}
