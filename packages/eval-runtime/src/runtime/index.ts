import { RunAdmission } from "./admission.js";
import type {
  EvalRunAdmission,
  EvalRunAdmissionDependencies,
  EvalRunResumer,
  EvalRunResumerDependencies,
} from "./model.js";
import { RunResumer } from "./resume.js";

export type {
  EvalRunAdmission,
  EvalRunAdmissionDependencies,
  EvalRunQueries,
  EvalRunResumer,
  EvalRunResumerDependencies,
  ProjectPlanReader,
  CurrentRun,
  ProjectRunState,
  ProjectView,
  ProjectSample,
  RunPreview,
  RunPreviewRequest,
  RunStopReporter,
  SamplingSnapshot,
  StageStopReason,
  StoppedStageReport,
} from "./model.js";
export type {
  RuntimeRunAdmission,
  RuntimeRunAdmissionCommand,
  RuntimeRunPlanDigests,
  RuntimeRunRequestIdentity,
  RuntimeRunRecord,
  RuntimeRecoveryStore,
  AttemptResourceSnapshot,
  EvaluationState,
  Revisioned,
  SamplingState,
  RuntimeStore,
} from "./store.js";
export { withoutRevision } from "./store.js";
export { requireSourceCommit } from "./admission.js";
export { toRunSnapshot, toSamplingSnapshot } from "./projection.js";
export {
  RuntimeAdmissionConflictError,
  RuntimeEntityNotFoundError,
  RuntimeInputError,
  RuntimeProjectBusyError,
  RuntimeRecordConflictError,
  RuntimeRecordPersistenceError,
  RuntimeRunIdentityConflictError,
  RuntimeRunStoppedError,
  type RuntimeAdmissionConflictReason,
  type RuntimeEntity,
  type RuntimePersistenceOutcome,
} from "./errors.js";
export {
  createRetryController,
  retryIdempotentOperation,
  type IdempotentRetryLoop,
  type RetryController,
  type RetryDecision,
  type RetryErrorDetails,
  type RetryOperation,
} from "./retry.js";
export {
  publishEvaluationScore,
  syncRunScores,
  type EvaluationScore,
  type EvaluationScorePort,
  type ScoreSyncSummary,
} from "./scores.js";
export {
  RESULT_INVALID_PREFIX,
  RESULT_NOT_SUBMITTED,
  extractFinalReplyResult,
  type EvaluationResultCheck,
  type EvaluationResultPort,
} from "./results.js";
export { safeLog, type RuntimeContext, type RuntimeLog } from "./log.js";
export { evaluationAgentEnded, executionAgentEnded, stageOwesResources, withFreshResourceBudget } from "./recovery.js";

export function createEvalRunAdmission(dependencies: EvalRunAdmissionDependencies): EvalRunAdmission {
  const admission = new RunAdmission(dependencies);
  return {
    preview: (request) => admission.preview(request),
    submit: (request) => admission.submit(request),
  };
}

export function createEvalRunResumer(dependencies: EvalRunResumerDependencies): EvalRunResumer {
  return new RunResumer(dependencies);
}
