export type {
  AgentFailureKind,
  AgentHandle,
  AgentSubmission,
  CollectAgentInput,
  CollectAgentResourcesInput,
  EnsureAgentInput,
  EvidenceBundleReader,
  EvidenceFileReader,
  EvidenceStore,
  ExportEvidenceInput,
  ExportedArtifact,
  ExportedEvidence,
  ExportedSubjectInput,
  ExportedTrajectoryEvent,
  Harness,
  HarnessRuntimeOptions,
  InspectAgentOperationInput,
  ImportEvidenceInput,
  MaterializeInitialDataInput,
  ResumeEvidenceInput,
  SubmitAgentInput,
  WaitForSubmissionInput,
} from "./model.js";
export {
  applyEvidenceLimits,
  createEvidenceStore,
  EvidenceIntegrityError,
  type EvidenceBlobStore,
} from "./evidence.js";
export { AGENT_FAILURE_KINDS } from "./model.js";
export {
  PI_TRAJECTORY_FORMAT, HISTORICAL_SP_TRAJECTORY_FORMAT, TrajectoryFormatError,
  describeTrajectoryRecord, openTrajectory, parseTrajectoryRecord, readTrajectoryBookkeeping,
  readArchivedFinalReply, readNativeFinalReply, readNativeRecordDetail, storedTrajectoryFormat, trajectoryRecordIdentity,
  isEvalTrajectoryDelivered,
  type NativeTrajectoryWrite, type NativeTrajectoryEntry, type NativeTrajectoryMessage,
  type NativeTrajectoryAssistant, type NativeTrajectoryToolResult, type TrajectoryBookkeepingData,
  type TrajectoryRecord, type TrajectoryResource, type TrajectoryDeliveryState, type TrajectoryCategory, type TrajectoryRecordDescription,
} from "./trajectory.js";
export {
  belongsToNativeExecution, distinctNativeRecords, nativeExecutionKey, nativeExecutionMembers,
  openNativeExecution, parseSafeTrajectoryRecord,
  type NativeExecutionScope, type NativeExecutionView,
} from "./native-execution.js";
export { nativeResourceReadinessSchema, validateNativeResourceScope } from "./resource-wire.js";
export { readNativeTrajectoryPage, type NativeTrajectoryPage } from "./native-page.js";

export class AgentIdentityConflictError extends Error {
  readonly retryable = false;

  constructor(readonly chatId: string, options?: ErrorOptions) {
    super(`Chat identity ${chatId} is already bound to different creation facts`, options);
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
