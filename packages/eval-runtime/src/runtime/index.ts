import { RunAdmission } from "./admission.js";
import type {
  EvalRunAdmission,
  EvalRunAdmissionDependencies,
  EvalRunResumer,
  EvalRunResumerDependencies,
} from "./model.js";
import { RunResumer } from "./resume.js";

export type {
  AgentOption,
  EvalRunAdmission,
  EvalRunAdmissionDependencies,
  EvalRunQueries,
  EvalRunResumer,
  EvalRunResumerDependencies,
  RuntimeAdmissionCatalog,
  RuntimeCatalog,
  RuntimeEvaluationContext,
  Sample,
  SamplingSnapshot,
  RuntimeSamplingContext,
} from "./model.js";
export type {
  RuntimeRunAdmission,
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
export {
  createRetryController,
  type RetryController,
  type RetryDecision,
  type RetryOperation,
} from "./retry.js";
export {
  createAgentScheduler,
  type AgentScheduler,
  type AgentSchedulerOptions,
} from "./scheduler.js";

export function createEvalRunAdmission(dependencies: EvalRunAdmissionDependencies): EvalRunAdmission {
  const admission = new RunAdmission(dependencies);
  return {
    start: (request) => admission.start(request),
    evaluate: (request) => admission.evaluate(request),
    pipeline: (request) => admission.pipeline(request),
  };
}

export function createEvalRunResumer(dependencies: EvalRunResumerDependencies): EvalRunResumer {
  return new RunResumer(dependencies);
}
