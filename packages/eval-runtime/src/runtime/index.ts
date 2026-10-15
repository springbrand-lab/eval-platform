import { RunAdmission } from "./admission.js";
import type {
  EvalRunAdmission,
  EvalRunAdmissionDependencies,
  EvalRunResumer,
  EvalRunResumerDependencies,
  EvalRuntime,
  EvalRuntimeDependencies,
} from "./model.js";
import { createRunQueries } from "./queries.js";
import { RunRecords } from "./records.js";
import { RunResumer } from "./resume.js";

export type {
  AgentOption,
  EvalRuntime,
  EvalRuntimeDependencies,
  EvalRunAdmission,
  EvalRunAdmissionDependencies,
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

export function createEvalRuntime(dependencies: EvalRuntimeDependencies): EvalRuntime {
  const { catalog, store } = dependencies;
  const getSamples = catalog.getSamples.bind(catalog);
  const admission = createEvalRunAdmission(dependencies);
  const resumer = new RunResumer({
    ...dependencies,
    getSamples,
    getEvaluationOutputSchema: catalog.getEvaluationOutputSchema.bind(catalog),
  });
  return {
    listProjects: () => catalog.listProjects(),
    listAgents: (role) => catalog.listAgents(role),
    listDatasets: () => catalog.listDatasets(),
    listData: (datasetId) => catalog.listData(datasetId),
    listSamples: (dataId) => catalog.listSamples(dataId),
    ...admission,
    ...createRunQueries(store, new RunRecords(store, getSamples)),
    resume: (runId) => resumer.resume(runId),
  };
}

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
