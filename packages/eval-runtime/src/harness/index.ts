export type {
  AgentFailureKind,
  AgentHandle,
  AgentSubmission,
  CollectAgentInput,
  CollectAgentResourcesInput,
  EnsureAgentInput,
  EvaluationInput,
  Harness,
  HarnessRuntimeOptions,
  InspectAgentOperationInput,
  MaterializeInitialDataInput,
  SubmitAgentInput,
  WaitForSubmissionInput,
} from "./model.js";

export class AgentIdentityConflictError extends Error {
  readonly retryable = false;

  constructor(readonly submissionId: string) {
    super(`Agent identity ${submissionId} is already bound to different creation facts`);
    this.name = "AgentIdentityConflictError";
  }
}
