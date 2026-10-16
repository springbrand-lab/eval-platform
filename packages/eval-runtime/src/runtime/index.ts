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
  SamplingSnapshot,
} from "./model.js";
export type {
  RuntimeRunAdmission,
  RuntimeRunAdmissionCommand,
  RuntimeRunPlanDigests,
  RuntimeRunRequestIdentity,
  RuntimeRunRecord,
  RuntimeRecoveryStore,
  SamplingState,
  RuntimeStore,
} from "./store.js";
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
export type { RetryController, RetryDecision, RetryOperation } from "./retry.js";
export {
  publishEvaluationScore,
  syncRunScores,
  type EvaluationScore,
  type EvaluationScorePort,
  type ScoreSyncSummary,
} from "./scores.js";

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
