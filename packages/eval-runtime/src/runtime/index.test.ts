import { describe, expect, it, vi } from "vitest";
import type {
  AgentFramework,
  AgentResourceSnapshot,
  EvidenceExportProgress,
  EvaluationPlan,
  EvaluationRecord,
  ExecutionPlan,
  ProjectDatasetSnapshot,
  RunOperation,
  RunRequest,
  RunTargetSelector,
  RetryPolicy,
} from "@eval-platform/eval-contracts";
import {
  summarizeResourceSnapshot,
  DEFAULT_EVIDENCE_LIMITS,
  EVIDENCE_EXPORT_MAX_PASSES,
  OBSERVATION_MAX_PASSES,
  RESOURCE_CHECK_INTERVAL_MS,
  RESOURCE_WAIT_MS,
  SP_PI_TRAJECTORY_FORMAT,
  isStageRecoveryPending,
} from "@eval-platform/eval-contracts";
import { digestExecutionPlan, digestJson } from "../plan/index.js";
import type {
  AgentHandle,
  AgentSubmission,
  CollectAgentResourcesInput,
  EvidenceStore,
  Harness,
} from "../harness/index.js";
import { AgentHandleNotFoundError, createEvidenceStore } from "../harness/index.js";
import { createMemoryEvidenceBlobs, exportedEvidence, publicAssistantRecord, publicNativeRecords, testClock } from "../harness/evidence-test-support.js";
import type { ProjectPlanReader, ProjectSample } from "./model.js";
import { createRetryController as createProductionRetryController, DEFAULT_RETRY_POLICY } from "./retry.js";
import type {
  EvaluationState,
  RuntimeRunAdmission,
  RuntimeRunRecord,
  SamplingState,
  RuntimeStore,
} from "./store.js";
import { withoutRevision } from "./store.js";
import { equalJson } from "@eval-platform/eval-contracts";
import {
  RuntimeAdmissionConflictError,
  RuntimeEntityNotFoundError,
  RuntimeInputError,
  RuntimeProjectBusyError,
  RuntimeRecordConflictError,
  RuntimeRunIdentityConflictError,
  RuntimeRunStoppedError,
} from "./errors.js";
import { RESULT_INVALID_PREFIX, RESULT_NOT_SUBMITTED, type EvaluationResultPort } from "./results.js";
import type { RetryController, RetryOperation } from "./retry.js";
import {
  createEvalRunAdmission,
  createEvalRunResumer as createResumerWithReporter,
  toRunSnapshot,
  toSamplingSnapshot,
  withFreshResourceBudget,
  type EvalRunQueries,
  type EvalRunResumerDependencies,
  type RunStopReporter,
} from "./index.js";
import { RunRecords } from "./records.js";
const SESSIONS_BUNDLE_ID = "789d7cc3-bb3e-41cf-b7a8-0f55ab1e9efb";
const SESSION_ID = "3e76a4ff-8352-4de5-b8cd-ce072b8ffa69";
const MATERIALS_BUNDLE_ID = "41f13a32-61d8-4d4d-bc19-723e976688a4";
const MATERIAL_ID = "0325f6ed-2649-425b-b121-12d25a2d3bf3";
const EVAL_BUNDLE_ID = "676556c9-32bd-41cf-ad54-63e1b03ce1ea";
const EVAL_MATERIAL_ID = "fa32ac9f-ec04-4821-ac67-3438a8b7b1d8";
const SUBJECT_MATERIALS = [
  { bundleId: MATERIALS_BUNDLE_ID, materialId: MATERIAL_ID },
  { bundleId: EVAL_BUNDLE_ID, materialId: MATERIAL_ID },
];
const EVAL_MATERIALS = [
  { bundleId: EVAL_BUNDLE_ID, materialId: EVAL_MATERIAL_ID },
  { bundleId: MATERIALS_BUNDLE_ID, materialId: EVAL_MATERIAL_ID },
];

const PROJECT_ID = "project-1";
const SUBJECT = { ownerUserId: "user-1", userAgentId: "subject-agent" };
const EVALUATOR = { ownerUserId: "user-1", userAgentId: "evaluator-agent" };
const SOURCE_COMMIT = "a".repeat(40);
const OUTPUT_SCHEMA = { type: "object", properties: { score: { type: "number" } } } as const;

type WithDefaultReporter<T extends { readonly onError: unknown; readonly evidence: unknown }> =
  Omit<T, "onError" | "evidence"> & { readonly onError?: T["onError"]; readonly evidence?: T["evidence"] };

/** Every Runtime in this file shares one in-memory evidence store, so seeded bundles open anywhere. */
const TEST_EVIDENCE_BLOBS = createMemoryEvidenceBlobs();
const TEST_EVIDENCE: EvidenceStore = createEvidenceStore(TEST_EVIDENCE_BLOBS, () => "2026-10-15T00:00:00.000Z");
const SEEDED_EVIDENCE = await TEST_EVIDENCE.resume({
  evidence: exportedEvidence({ samplingId: "seeded-sampling" }),
  limits: DEFAULT_EVIDENCE_LIMITS,
});

type RuntimeDependencies = WithDefaultReporter<Omit<EvalRunResumerDependencies, "plans" | "store">> & {
  readonly sourceCommit?: string;
  readonly store: TestStore;
  /** Bound to the Store; later Runtimes on the same Store reuse them. */
  readonly plans?: TestPlans;
};


function createRunQueries(store: RuntimeStore, records: RunRecords): EvalRunQueries {
  return {
    async getRun(runId) {
      const run = await store.getRun(runId);
      if (!run) throw new RuntimeEntityNotFoundError("run", runId);
      return toRunSnapshot(run, await records.samplings(run.samplingIds), await records.evaluations(run.evaluationIds));
    },
    async getSampling(samplingId) {
      const sampling = await store.getSampling(samplingId);
      if (!sampling) throw new RuntimeEntityNotFoundError("sampling", samplingId);
      return toSamplingSnapshot(sampling);
    },
    async getEvaluation(evaluationId) {
      const evaluation = await store.getEvaluation(evaluationId);
      if (!evaluation) throw new RuntimeEntityNotFoundError("evaluation", evaluationId);
      return structuredClone(withoutRevision(evaluation));
    },
    async listEvaluations(samplingId) {
      return (await store.listEvaluations(samplingId)).map((record) => structuredClone(withoutRevision(record)));
    },
  };
}

/** Composes the production admission and resumer entries with Store-backed reads, as API and Worker do. */
function createRuntime(dependencies: RuntimeDependencies) {
  const { store } = dependencies;
  if (dependencies.plans) store.usePlans(dependencies.plans);
  const plans = store.plans();
  const resumer = createEvalRunResumer({ ...dependencies, plans, store });
  const admission = createEvalRunAdmission({
    sourceCommit: dependencies.sourceCommit ?? SOURCE_COMMIT, plans, store,
    ...(dependencies.idFactory ? { idFactory: dependencies.idFactory } : {}),
  });
  return {
    ...admission,
    ...createRunQueries(store, new RunRecords(store, plans)),
    plans,
    resume: (runId: string) => resumer.resume(runId),
  };
}

function createEvalRunResumer(dependencies: WithDefaultReporter<EvalRunResumerDependencies>) {
  return createResumerWithReporter({
    ...dependencies,
    createRetryController: dependencies.createRetryController ?? noTransientRetryController,
    evidence: dependencies.evidence ?? TEST_EVIDENCE,
    onError: dependencies.onError ?? console.error,
  });
}

/** Existing orchestration tests opt into transient retries only where they cover that production policy. */
function noTransientRetryController(policy?: RetryPolicy): RetryController {
  const delegate = createProductionRetryController(policy);
  return {
    decide: (input) => input.operation === "restart"
      ? delegate.decide(input)
      : Promise.resolve({ shouldRetry: false, reason: input.failureKind }),
  };
}

/** Admission bound to a test Store and its Project plans. */
function createTestAdmission(store: TestStore) {
  return createEvalRunAdmission({ sourceCommit: SOURCE_COMMIT, plans: store.plans(), store });
}

/** A resumer bound to a test Store and its Project plans. */
function createTestResumer(store: TestStore, harness: Harness, options: Partial<WithDefaultReporter<EvalRunResumerDependencies>> = {}) {
  return createEvalRunResumer({ ...options, plans: store.plans(), harness, store });
}

const NO_RETRY = { maxRestarts: 0, initialBackoffMs: 0, maxBackoffMs: 0 } as const;
const EXECUTION_RUNTIME = { timeoutMs: 1_234 } as const;
const EVALUATION_RUNTIME = { timeoutMs: 5_678 } as const;

function executionPlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    harness: { kind: "sp", framework: "sp", agentConfig: SUBJECT },
    subjectAgentConfig: { sourceUserAgentId: "subject-source", name: "Subject", body: { model: "subject" } },
    executionConcurrency: 1,
    retryPolicy: NO_RETRY,
    ...overrides,
  };
}

function evaluationPlan(overrides: Partial<EvaluationPlan> = {}): EvaluationPlan {
  return {
    evaluationHarness: { kind: "sp", framework: "sp", agentConfig: EVALUATOR },
    evaluatorAgentConfig: { sourceUserAgentId: "evaluator-source", name: "Evaluator", body: { model: "evaluator" } },
    evaluationConcurrency: 1,
    retryPolicy: NO_RETRY,
    outputSchema: { outputSchemaId: "output-schema-1", digest: "b".repeat(64) },
    ...overrides,
  };
}

const RETRY_ONE = { maxRestarts: 1, initialBackoffMs: 0, maxBackoffMs: 0 } as const;
const RETRY_TWO = { maxRestarts: 2, initialBackoffMs: 0, maxBackoffMs: 0 } as const;

function subjectHarness(framework: AgentFramework = "sp", runtime?: typeof EXECUTION_RUNTIME): ExecutionPlan["harness"] {
  return { kind: "sp", framework, agentConfig: SUBJECT, ...(runtime === undefined ? {} : { runtime }) };
}

/** An in-memory Project plan. Tests replace its fields between Runs; a real execution plan never changes. */
interface TestPlans extends ProjectPlanReader {
  samples: readonly ProjectSample[];
  execution: ExecutionPlan;
  evaluation: EvaluationPlan | null;
  lock(): void;
}

function makePlans(
  samples: readonly ProjectSample[] = [makeSample("sample-1")],
  options: {
    readonly datasets?: readonly ProjectDatasetSnapshot[];
    readonly execution?: ExecutionPlan;
    readonly evaluation?: EvaluationPlan | null;
  } = {},
): TestPlans {
  let lockedAt: string | null = null;
  const datasets = options.datasets ?? [{
    datasetId: "dataset-1", name: "Dataset 1", kind: "general" as const,
    projectSampleIds: samples.map(({ projectSampleId }) => projectSampleId),
  }];
  const plans: TestPlans = {
    samples,
    execution: options.execution ?? executionPlan(),
    evaluation: options.evaluation === undefined ? evaluationPlan() : options.evaluation,
    lock() {
      lockedAt ??= "2026-10-15T00:00:00.000Z";
    },
    async getProjectPlan(projectId) {
      if (projectId !== PROJECT_ID) return null;
      const { execution, evaluation } = plans;
      return {
        project: {
          projectId, ownerUserId: "owner", name: "test", sourceBranch: "release-2.0.0", createdAt: "2026-10-01T00:00:00.000Z",
        },
        datasets,
        execution,
        executionPlanDigest: await digestExecutionPlan({ execution, datasets, samples: plans.samples }),
        evaluation: evaluation && { plan: evaluation, digest: await digestJson(evaluation), lockedAt },
      };
    },
    async getProjectSamples(projectId, projectSampleIds) {
      return projectSampleIds.map((id) => (
        projectId === PROJECT_ID ? plans.samples.find((sample) => sample.projectSampleId === id) ?? null : null
      ));
    },
    async getEvaluationOutputSchema(projectId) {
      return projectId === PROJECT_ID && plans.evaluation !== null ? OUTPUT_SCHEMA : null;
    },
  };
  return plans;
}

/** A whole-Project execution or pipeline request over these ProjectSamples. */
function projectRequest(
  operation: "execution" | "pipeline",
  idempotencyKey: string,
  projectSampleIds: readonly string[] = ["sample-1"],
): RunRequest {
  return {
    idempotencyKey, projectId: PROJECT_ID, operation, selector: { all: true },
    targets: { projectSampleIds: [...projectSampleIds], samplingIds: [] },
  };
}

/** An evaluation request for these Samplings. */
function evaluationRequest(samplingIds: readonly string[], idempotencyKey: string = crypto.randomUUID()): RunRequest {
  return {
    idempotencyKey, projectId: PROJECT_ID, operation: "evaluation", selector: { samplingIds: [...samplingIds] },
    targets: { projectSampleIds: [], samplingIds: [...samplingIds] },
  };
}

function createAutoResumingRuntime(dependencies: RuntimeDependencies) {
  const onError = dependencies.onError ?? console.error;
  const store: TestStore = Object.create(dependencies.store);
  let runtime!: ReturnType<typeof createRuntime>;
  store.admitRun = async (command) => {
    const admission = await dependencies.store.admitRun(command);
    if (admission.created) {
      queueMicrotask(() => { void runtime.resume(admission.run.runId).catch(onError); });
    }
    return admission;
  };
  runtime = createRuntime({ ...dependencies, onError, store });
  return runtime;
}

function makeSample(projectSampleId: string, overrides: Partial<ProjectSample> = {}): ProjectSample {
  return {
    projectSampleId,
    projectId: PROJECT_ID,
    dataId: "data-1",
    datasetIds: ["dataset-1"],
    samplingCount: 1,
    data: {
      dataId: "data-1",
      userPrompt: `Execute ${projectSampleId}`,
      evalPrompt: `Evaluate ${projectSampleId}`,
      json: { task: projectSampleId },
      initialSession: { bundleId: SESSIONS_BUNDLE_ID, sessionId: SESSION_ID },
      initialMaterials: SUBJECT_MATERIALS,
      evalInitialMaterials: EVAL_MATERIALS,
      metadata: { source: "test" },
    },
    ...overrides,
  };
}

/** An in-memory RuntimeStore implementing the documented admission transaction. */
interface TestStore extends RuntimeStore {
  plans(): TestPlans;
  usePlans(plans: TestPlans): void;
  resourceSnapshot(target: SnapshotTarget): AgentResourceSnapshot | undefined;
}

interface SnapshotTarget {
  readonly samplingId: string;
  readonly evaluationId?: string;
  readonly attemptId: string;
}

interface StoreOptions {
  readonly plans?: TestPlans;
  readonly beforeRunCommit?: (run: RuntimeRunRecord) => void;
}

function makeStore(options: StoreOptions = {}): TestStore {
  const runs = new Map<string, RuntimeRunRecord>();
  const samplings = new Map<string, SamplingState>();
  const evaluations = new Map<string, EvaluationState>();
  const resourceSnapshots = new Map<string, AgentResourceSnapshot>();
  let plans = options.plans ?? makePlans();
  const owesWork = <T>(ids: readonly string[], records: Map<string, T>, stage: (record: T) => SamplingState["execution"]) => (
    ids.some((id) => { const record = records.get(id); return record !== undefined && isStageRecoveryPending(stage(record)); })
  );
  const isActive = (run: RuntimeRunRecord) => (run.stopRequested === true && run.stopFinalized !== true)
    || (!run.stopRequested && run.operation !== "evaluation" && owesWork(run.samplingIds, samplings, (record) => record.execution))
    || (!run.stopRequested && run.operation !== "execution" && owesWork(run.evaluationIds, evaluations, (record) => record.status));
  const projectSamplings = (projectId: string, projectSampleIds: readonly string[]) => projectSampleIds.flatMap((id) => (
    [...samplings.values()]
      .filter((sampling) => sampling.projectId === projectId && sampling.projectSampleId === id)
      .sort((left, right) => left.samplingId < right.samplingId ? -1 : 1)
  ));
  return {
    plans: () => plans,
    usePlans(next) {
      plans = next;
    },
    async withRunDispatchGate(runId, dispatch) {
      if (runs.get(runId)?.stopRequested) throw new RuntimeRunStoppedError(runId);
      return dispatch();
    },
    async getRun(runId) {
      return runs.get(runId) ?? null;
    },
    async findRunByIdempotencyKey(projectId, idempotencyKey) {
      return [...runs.values()].find(
        (run) => run.projectId === projectId && run.requestIdentity.idempotencyKey === idempotencyKey,
      ) ?? null;
    },
    async listProjectSamplings(projectId, projectSampleIds) {
      return projectSamplings(projectId, projectSampleIds);
    },
    async admitRun({ run, replacedSamplingIds, samplings: created, evaluations: added }) {
      const existingRun = [...runs.values()].find(
        (existing) => existing.projectId === run.projectId
          && existing.requestIdentity.idempotencyKey === run.requestIdentity.idempotencyKey,
      );
      if (existingRun) {
        if (existingRun.requestIdentity.requestFingerprint !== run.requestIdentity.requestFingerprint) {
          throw new RuntimeRunIdentityConflictError("request identity is already bound to different evaluation run facts");
        }
        return { run: existingRun, created: false } satisfies RuntimeRunAdmission;
      }
      const active = [...runs.values()].find((existing) => existing.projectId === run.projectId && isActive(existing));
      if (active) throw new RuntimeProjectBusyError(run.projectId, active.runId);
      const plan = await plans.getProjectPlan(run.projectId);
      if (!plan) throw new RuntimeEntityNotFoundError("project", run.projectId);
      const evaluates = run.operation !== "execution";
      if (evaluates && !plan.evaluation) {
        throw new RuntimeAdmissionConflictError("evaluation-plan-required", "evaluation plan required");
      }
      if (plan.executionPlanDigest !== run.planDigests.execution
        || (evaluates && plan.evaluation?.digest !== run.planDigests.evaluation)) {
        throw new RuntimeAdmissionConflictError("plan-changed", "Project plan changed");
      }
      if (run.operation === "evaluation") {
        if (run.samplingIds.some((id) => samplings.get(id)?.execution.status !== "succeeded")) {
          throw new RuntimeAdmissionConflictError("sampling-unavailable", "target Sampling is unavailable");
        }
      } else {
        const current = [
          ...projectSamplings(run.projectId, run.targets.projectSampleIds).map(({ samplingId }) => samplingId),
          ...run.targets.samplingIds,
        ];
        if (run.targets.samplingIds.some((id) => !samplings.has(id))
          || !equalJson([...current].sort(), [...replacedSamplingIds].sort())) {
          throw new RuntimeAdmissionConflictError("stale-targets", "targets changed");
        }
      }
      options.beforeRunCommit?.(run);
      const replaced = new Set(run.operation === "evaluation" ? [] : replacedSamplingIds);
      const reevaluated = new Set(run.operation === "evaluation" ? run.samplingIds : []);
      for (const samplingId of replaced) samplings.delete(samplingId);
      for (const [evaluationId, evaluation] of evaluations) {
        if (replaced.has(evaluation.samplingId) || reevaluated.has(evaluation.samplingId)) evaluations.delete(evaluationId);
      }
      for (const [runId, existing] of runs) {
        runs.set(runId, {
          ...existing,
          samplingIds: existing.samplingIds.filter((id) => !replaced.has(id) && !(existing.operation === "evaluation" && reevaluated.has(id))),
          evaluationIds: existing.evaluationIds.filter((id) => evaluations.has(id)),
        });
      }
      runs.set(run.runId, run);
      for (const record of created) samplings.set(record.samplingId, { ...record, revision: 0 });
      for (const evaluation of added) evaluations.set(evaluation.evaluationId, { ...evaluation, revision: 0 });
      if (evaluates) plans.lock();
      return { run, created: true } satisfies RuntimeRunAdmission;
    },
    async updateEvaluation(record, expected, resources) {
      if (evaluations.get(record.evaluationId)?.revision !== expected.revision) {
        throw new RuntimeRecordConflictError("Evaluation changed before update");
      }
      evaluations.set(record.evaluationId, { ...record, revision: expected.revision + 1 });
      if (resources) {
        const { samplingId, evaluationId } = record;
        if ("kind" in resources.snapshot) throw new Error("Test Store has no paged resource persistence");
        resourceSnapshots.set(snapshotKey({ samplingId, evaluationId, attemptId: resources.attemptId }), resources.snapshot);
      }
    },
    async getEvaluation(evaluationId) {
      return evaluations.get(evaluationId) ?? null;
    },
    async getEvaluations(evaluationIds) {
      return evaluationIds.map((evaluationId) => evaluations.get(evaluationId) ?? null);
    },
    async listEvaluations(samplingId) {
      return [...evaluations.values()].filter((evaluation) => evaluation.samplingId === samplingId);
    },
    async updateSampling(state, expected, resources) {
      if (samplings.get(state.samplingId)?.revision !== expected.revision) {
        throw new RuntimeRecordConflictError("Sampling changed before update");
      }
      samplings.set(state.samplingId, { ...state, revision: expected.revision + 1 });
      if (resources) {
        if ("kind" in resources.snapshot) throw new Error("Test Store has no paged resource persistence");
        resourceSnapshots.set(snapshotKey({ samplingId: state.samplingId, attemptId: resources.attemptId }), resources.snapshot);
      }
    },
    async getSampling(samplingId) {
      return samplings.get(samplingId) ?? null;
    },
    async getSamplings(samplingIds) {
      return samplingIds.map((samplingId) => samplings.get(samplingId) ?? null);
    },
    resourceSnapshot: (target) => resourceSnapshots.get(snapshotKey(target)),
  };
}

function snapshotKey({ samplingId, evaluationId, attemptId }: SnapshotTarget): string {
  return `${samplingId}/${evaluationId ?? ""}/${attemptId}`;
}

/** A seeded succeeded execution with its output is evaluable, so it gets a stored bundle unless it set one. */
async function seedSampling(store: RuntimeStore, record: SamplingState): Promise<void> {
  const expected = await store.getSampling(record.samplingId);
  if (!expected) throw new Error("Unknown Sampling fixture");
  const evaluable = record.execution.status === "succeeded" && record.artifacts !== undefined
    && record.trajectory !== undefined && !("evidence" in record);
  await store.updateSampling(evaluable ? { ...record, evidence: SEEDED_EVIDENCE } : record, expected);
}

async function saved(store: RuntimeStore, samplingId: string): Promise<SamplingState> {
  const sampling = await store.getSampling(samplingId);
  if (!sampling) throw new Error(`Sampling ${samplingId} is not stored`);
  return sampling;
}

async function savedEvaluation(store: RuntimeStore, evaluationId: string): Promise<EvaluationState> {
  const evaluation = await store.getEvaluation(evaluationId);
  if (!evaluation) throw new Error(`Evaluation ${evaluationId} is not stored`);
  return evaluation;
}

async function seedEvaluation(store: RuntimeStore, record: EvaluationRecord): Promise<void> {
  const expected = await store.getEvaluation(record.evaluationId);
  if (!expected) throw new Error("Unknown Evaluation fixture");
  await store.updateEvaluation({ ...record, revision: expected.revision }, expected);
}

function makeSubmission(status: AgentSubmission["status"] = "completed", submissionId = "submission-1"): AgentSubmission {
  return {
    submissionId,
    status,
    accepted: true,
    retryable: false,
  };
}

const FINALIZED_READINESS = {
  receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: 0, pendingRuntimeEvents: 0,
  actionCharges: { complete: true, unsettledExecutions: 0, missingExecutionIds: 0 },
};

const PENDING_READINESS = {
  receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: 2, pendingRuntimeEvents: 0,
  actionCharges: { complete: false, unsettledExecutions: 1, missingExecutionIds: 0 },
};

/** SP readiness for the requested scope; `finalized` decides each check. */
function mockReadiness(harness: Harness, finalized: (input: CollectAgentResourcesInput) => boolean): void {
  vi.mocked(harness.inspectAgentResources).mockImplementation(async (input) => {
    const ready = finalized(input);
    return {
      scope: { chatId: input.handle.chatId, idempotencyKey: input.idempotencyKey, submissionId: input.submissionId ?? "submission-1" },
      observedAt: "2026-10-08T00:00:00.000Z",
      finalized: ready,
      readiness: ready ? FINALIZED_READINESS : PENDING_READINESS,
    };
  });
}

function makeHarness(): Harness {
  const submissionIds = new Map<string, string>();
  const operationKey = (handle: AgentHandle, idempotencyKey: string) =>
    JSON.stringify([handle.chatId, idempotencyKey]);
  const submissionIdFor = (handle: AgentHandle, idempotencyKey: string) =>
    submissionIds.get(operationKey(handle, idempotencyKey));
  const submit = (handle: AgentHandle, idempotencyKey: string): AgentSubmission => {
    const key = operationKey(handle, idempotencyKey);
    let submissionId = submissionIds.get(key);
    if (!submissionId) {
      submissionId = `generated-submission-${submissionIds.size + 1}`;
      submissionIds.set(key, submissionId);
    }
    return makeSubmission("completed", submissionId);
  };
  return {
    ensureAgent: vi.fn(async ({ role, framework, samplingId, chatId, evaluationId, agentConfig }): Promise<AgentHandle> => ({
      ownerUserId: agentConfig.ownerUserId,
      role,
      framework,
      samplingId,
      chatId,
      ...(evaluationId === undefined ? {} : { evaluationId }),
    })),
    materializeInitialData: vi.fn(async () => ({
      manifestHash: "manifest-1",
      target: "workspace" as const,
      materials: [],
    })),
    submitAgent: vi.fn(async ({ handle, idempotencyKey }) => submit(handle, idempotencyKey)),
    restartAgent: vi.fn(async ({ handle, idempotencyKey }) => submit(handle, idempotencyKey)),
    waitForSubmission: vi.fn(async ({ handle, idempotencyKey }) => {
      const submissionId = submissionIdFor(handle, idempotencyKey);
      if (!submissionId) throw new Error("Cannot wait for an unknown submission");
      return makeSubmission("completed", submissionId);
    }),
    inspectAgentOperation: vi.fn(async ({ handle, idempotencyKey }) => {
      const submissionId = submissionIdFor(handle, idempotencyKey);
      return submissionId ? makeSubmission("completed", submissionId) : null;
    }),
    stopAgent: vi.fn(async () => undefined),
    collectExecution: vi.fn(async ({ handle }) => ({
      samplingId: handle.samplingId,
      status: "succeeded" as const,
      artifacts: [{ artifactId: "artifact-1", kind: "project", path: "/eval/output" }],
      trajectory: { trajectoryId: "trajectory-1", source: "subject" as const, path: "/eval/trajectory.jsonl" },
    })),
    collectEvaluation: vi.fn(async () => ({
      status: "succeeded" as const,
      artifacts: [{ artifactId: "evaluation-artifact-1", kind: "evaluation", path: "/eval/result" }],
      structuredOutput: { path: "/output/result.json", content: '{"score":0.9}' },
      trajectory: { trajectoryId: "trajectory-2", source: "evaluator" as const, path: "/eval/evaluation.jsonl" },
    })),
    readFinalReply: vi.fn(async (): Promise<string | undefined> => undefined),
    inspectAgentResources: vi.fn(async ({ handle, idempotencyKey, submissionId }) => {
      const resolvedSubmissionId = submissionId ?? submissionIdFor(handle, idempotencyKey);
      if (!resolvedSubmissionId) throw new Error("Cannot inspect resources for an unknown submission");
      return {
        scope: { chatId: handle.chatId, submissionId: resolvedSubmissionId, idempotencyKey },
        observedAt: "2026-10-08T00:00:00.000Z",
        finalized: true,
        readiness: FINALIZED_READINESS,
      };
    }),
    collectAgentResources: vi.fn(async ({ handle, idempotencyKey, submissionId }) => {
      const resolvedSubmissionId = submissionId ?? submissionIdFor(handle, idempotencyKey);
      if (!resolvedSubmissionId) throw new Error("Cannot collect resources for an unknown submission");
      return {
        scope: { chatId: handle.chatId, submissionId: resolvedSubmissionId, idempotencyKey },
        observedAt: "2026-10-08T00:00:00.000Z",
        finalized: true,
        coverage: {
          usageEvents: "complete" as const,
          nativeRecords: "complete" as const,
          billingSettlements: "complete" as const,
        },
        usageEvents: [],
        nativeRecords: [],
        billingSettlements: [],
        readiness: FINALIZED_READINESS,
      };
    }),
    exportEvidence: vi.fn(async ({ handle, submissionId }) => exportedEvidence({
      samplingId: handle.samplingId, chatId: handle.chatId, submissionId,
    })),
    importEvidence: vi.fn(async () => undefined),
  };
}

function makeResources(input: CollectAgentResourcesInput): AgentResourceSnapshot {
  const { handle, idempotencyKey } = input;
  const submissionId = input.submissionId ?? "submission-1";
  const eventId = `${submissionId}:${idempotencyKey}:usage`;
  const usage = {
    eventId,
    runId: idempotencyKey,
    kind: "assistant_model",
    outcome: "billable",
    metrics: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 30, reasoningTokens: 2 },
    providerMetadata: { provider: "source-provider", model: `${handle.role}-model` },
    providerCostUsd: { input: 0.1, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: 0.13 },
    sourceExtension: { retained: [true, null, "original"] },
  };
  return {
    scope: { chatId: handle.chatId, submissionId, idempotencyKey },
    observedAt: "2026-10-08T00:00:00.000Z",
    finalized: true,
    readiness: FINALIZED_READINESS,
    coverage: { usageEvents: "complete", nativeRecords: "complete", billingSettlements: "complete" },
    usageEvents: [usage],
    nativeRecords: publicNativeRecords([1, 2, 3, 4, 5], { chatId: handle.chatId, submissionId }),
    billingSettlements: [{
      eventId,
      usage,
      accountId: "user-1",
      status: "settled",
      ratedUnits: 30,
      debitedUnits: 20,
      shortfallUnits: 10,
      platformOwned: { units: 10, reason: "insufficient_balance" },
      settledAtMs: 300,
    }, {
      execution_id: `${eventId}:action`,
      charged_credits: 5,
      service_id: "paid-tool",
      status: "succeeded",
    }],
  };
}

function makeRetryControllerFactory(
  retryCounts: Partial<Record<RetryOperation, number>>,
): () => RetryController {
  return () => {
    const remaining = new Map<RetryOperation, number>(
      Object.entries(retryCounts) as [RetryOperation, number][],
    );
    return {
      async decide({ operation, failureKind }) {
        const count = remaining.get(operation) ?? 0;
        if (count === 0) return { shouldRetry: false, reason: failureKind };
        remaining.set(operation, count - 1);
        return { shouldRetry: true, reason: failureKind, backoffMs: 0 };
      },
    };
  };
}

async function waitForTerminal(runtime: ReturnType<typeof createAutoResumingRuntime>, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await runtime.getRun(runId);
    if (snapshot.status === "succeeded" || snapshot.status === "failed") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("runtime did not reach a terminal state");
}

describe("eval runtime orchestration", () => {
  it("runs independent samplings and collects initial data, artifacts and trajectory", async () => {
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    runtime.plans.samples = [makeSample("sample-1", { samplingCount: 2 })];
    const run = await runtime.submit(projectRequest("execution", "test-request"));
    const snapshot = await waitForTerminal(runtime, run.runId);

    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.sourceCommit).toBe(SOURCE_COMMIT);
    expect(run.samplingIds).toHaveLength(2);
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(2);
    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
    const preparationInputs = vi.mocked(harness.materializeInitialData).mock.calls.map(([input]) => input);
    expect(new Set(preparationInputs.map((input) => input.handle.chatId)).size).toBe(2);
    expect(new Set(preparationInputs.map((input) => input.idempotencyKey)).size).toBe(2);
    for (const input of preparationInputs) {
      expect(input.idempotencyKey).toBe(`initial-data:${input.handle.chatId}`);
      expect(input.data.initialSession).toEqual({ bundleId: SESSIONS_BUNDLE_ID, sessionId: SESSION_ID });
      expect(input.data.initialMaterials).toEqual(SUBJECT_MATERIALS);
      expect(input.data).not.toHaveProperty("evalInitialMaterials");
      expect(input.data).not.toHaveProperty("sampleId");
      expect(input.data).not.toHaveProperty("dataId");
    }
  });

  describe.each(["pipeline", "independent"] as const)("%s business-field preservation", (operation) => {
    it.each(["source-sample-42", 42, { source: "external", id: 42 }, ["first", "second"]])(
      "keeps platform ProjectSample identity separate from business sampleId %j for both Agents",
      async (businessSampleId) => {
        const sample = {
          ...makeSample("sample-1"),
          data: {
            ...makeSample("sample-1").data,
            sampleId: businessSampleId,
            data: { sampleId: "nested-business-id" },
            expectedOutput: { passed: true },
          },
        };
        const harness = makeHarness();
        const store = makeStore();
        const runtime = createAutoResumingRuntime({ plans: makePlans([sample]), harness, store });
        const execution = operation === "pipeline"
          ? await runtime.submit(projectRequest("pipeline", "business-sample-id-pipeline"))
          : await runtime.submit(projectRequest("execution", "business-sample-id-execution"));
        await expect(waitForTerminal(runtime, execution.runId)).resolves.toMatchObject({ status: "succeeded" });
        if (operation === "independent") {
          const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
          await expect(waitForTerminal(runtime, evaluation.runId)).resolves.toMatchObject({ status: "succeeded" });
        }

        const preparations = vi.mocked(harness.materializeInitialData).mock.calls.map(([input]) => input);
        expect(preparations).toHaveLength(2);
        const subject = preparations.find((input) => input.handle.role === "subject")!;
        const evaluator = preparations.find((input) => input.handle.role === "evaluator")!;
        const { dataId: _dataId, evalPrompt: _evalPrompt,
          evalInitialMaterials: _evalMaterials, ...expectedSubject } = sample.data;
        const { initialSession: _initialSession, userPrompt: _subjectPrompt,
          initialMaterials: _subjectMaterials, ...evaluationFields } = expectedSubject;
        const expectedEvaluator = {
          ...evaluationFields, userPrompt: sample.data.evalPrompt,
          initialMaterials: sample.data.evalInitialMaterials,
        };
        expect(subject.data).toEqual(expectedSubject);
        expect(evaluator.data).toEqual(expectedEvaluator);
        expect(subject.data.sampleId).toEqual(businessSampleId);
        expect(evaluator.data.sampleId).toEqual(businessSampleId);
        expect(subject.data).not.toHaveProperty("dataId");
        expect(evaluator.data).not.toHaveProperty("dataId");
        await expect(runtime.getSampling(execution.samplingIds[0]!)).resolves.toMatchObject({ projectSampleId: "sample-1" });
        const state = await store.getSampling(execution.samplingIds[0]!);
        expect(state?.projectSampleId).toBe(sample.projectSampleId);
        expect(state).not.toHaveProperty("data");
        expect(state).not.toHaveProperty("sample");
      },
    );
  });

  it("rejects unsafe integer business fields before creating an execution Agent", async () => {
    const sample = {
      ...makeSample("sample-1"),
      data: { ...makeSample("sample-1").data, externalDataId: Number.MAX_SAFE_INTEGER + 1 },
    };
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({ plans: makePlans([sample]), harness, store: makeStore() });
    const run = await runtime.submit(projectRequest("execution", "unsafe-sample-number"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
    expect(harness.ensureAgent).not.toHaveBeenCalled();
    expect(harness.materializeInitialData).not.toHaveBeenCalled();
    expect(harness.submitAgent).not.toHaveBeenCalled();
  });

  it("submits the required prompt unchanged and materializes every extra field without optional resources", async () => {
    const sample = {
      ...makeSample("sample-1"),
      data: {
        dataId: "data-1",
        userPrompt: "  Build the homepage\nKeep the current style.  ",
        requirements: ["responsive", "accessible"],
        expectedOutput: { pages: 3 },
        referenceText: "design notes",
        customFlag: false,
      },
    };
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({ plans: makePlans([sample]), harness, store: makeStore() });
    const run = await runtime.submit(projectRequest("execution", "standalone-prompt"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });
    const preparation = vi.mocked(harness.materializeInitialData).mock.calls[0]![0];
    expect(preparation.data).toEqual({
      userPrompt: sample.data.userPrompt,
      requirements: sample.data.requirements,
      expectedOutput: sample.data.expectedOutput,
      referenceText: sample.data.referenceText,
      customFlag: sample.data.customFlag,
    });
    expect(preparation.data).not.toHaveProperty("initialSession");
    expect(preparation.data).not.toHaveProperty("initialMaterials");
    expect(harness.submitAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      prompt: sample.data.userPrompt,
    }));
  });

  it("waits for Session restoration and material preparation before submitting a new task", async () => {
    const harness = makeHarness();
    let preparationStarted!: () => void;
    const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
    let finishPreparation!: () => void;
    const pending = new Promise<void>((resolve) => { finishPreparation = resolve; });
    vi.mocked(harness.materializeInitialData).mockImplementation(async () => {
      preparationStarted();
      await pending;
      return { manifestHash: "hash", target: "workspace", materials: [] };
    });
    const runtime = createAutoResumingRuntime({ harness, store: makeStore() });
    const run = await runtime.submit(projectRequest("execution", "wait-for-session"));
    await started;
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.collectExecution).not.toHaveBeenCalled();
    finishPreparation();
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });
    expect(harness.submitAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: "Execute sample-1" }));
  });

  it.each([undefined, "", " \n\t", 123, ["task"]])(
    "rejects invalid current prompt %j before creating an Agent",
    async (userPrompt) => {
      const sample = { ...makeSample("sample-1"), data: { ...makeSample("sample-1").data, userPrompt } } as unknown as ProjectSample;
      const harness = makeHarness();
      const runtime = createAutoResumingRuntime({ plans: makePlans([sample]), harness, store: makeStore() });
      const run = await runtime.submit(projectRequest("execution", "invalid-prompt"));
      await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
      expect(harness.ensureAgent).not.toHaveBeenCalled();
      expect(harness.materializeInitialData).not.toHaveBeenCalled();
      expect(harness.submitAgent).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["initialSession", { bundleId: "bundle-only" }],
    ["initialMaterials", [{ bundleId: "bundle-only" }]],
  ] as const)(
    "rejects an incomplete %s reference without generating a replacement",
    async (field, reference) => {
      const sample = {
        ...makeSample("sample-1"),
        data: { ...makeSample("sample-1").data, [field]: reference },
      } as unknown as ProjectSample;
      const harness = makeHarness();
      const runtime = createAutoResumingRuntime({ plans: makePlans([sample]), harness, store: makeStore() });
      const run = await runtime.submit(projectRequest("execution", "incomplete-reference"));
      await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
      expect(harness.ensureAgent).not.toHaveBeenCalled();
      expect(harness.materializeInitialData).not.toHaveBeenCalled();
      expect(harness.submitAgent).not.toHaveBeenCalled();
    },
  );

  it("does not fall back to a fresh Session when SP initialization fails", async () => {
    const harness = makeHarness();
    vi.mocked(harness.materializeInitialData).mockRejectedValueOnce(new Error("initial Session is unavailable"));
    const runtime = createAutoResumingRuntime({ harness, store: makeStore() });
    const run = await runtime.submit(projectRequest("execution", "missing-session"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.waitForSubmission).not.toHaveBeenCalled();
    expect(harness.collectExecution).not.toHaveBeenCalled();
  });

  it.each(["sp", "codex", "cc"] as const)(
    "retries %s initialization with the same Agent, inputs and key when its response is lost",
    async (framework) => {
      const harness = makeHarness();
      const committedKeys = new Set<string>();
      vi.mocked(harness.materializeInitialData).mockImplementation(async ({ idempotencyKey }) => {
        if (!committedKeys.has(idempotencyKey)) {
          committedKeys.add(idempotencyKey);
          throw new Error("connection lost after initialization committed");
        }
        return { manifestHash: "manifest-1", target: "workspace", materials: [] };
      });
      const decide = vi.fn<RetryController["decide"]>()
        .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 25 })
        .mockResolvedValue({ shouldRetry: false });
      const sleep = vi.fn(async () => {
        expect(harness.submitAgent).not.toHaveBeenCalled();
        expect(harness.restartAgent).not.toHaveBeenCalled();
      });
      const runtime = createAutoResumingRuntime({
        plans: makePlans(undefined, { execution: executionPlan({ harness: subjectHarness(framework) }) }),
        harness,
        store: makeStore(),
        sleep,
        createRetryController: () => ({ decide }),
      });

      const run = await runtime.submit(projectRequest("execution", `initialization-response-lost-${framework}`));
      await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

      expect(committedKeys.size).toBe(1);
      expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
      expect(harness.materializeInitialData).toHaveBeenCalledTimes(2);
      const [first, second] = vi.mocked(harness.materializeInitialData).mock.calls;
      expect(second![0]).toEqual(first![0]);
      expect(first![0]).toMatchObject({
        handle: { framework },
        idempotencyKey: `initial-data:${first![0].handle.chatId}`,
        data: {
          userPrompt: "Execute sample-1",
          initialSession: { bundleId: SESSIONS_BUNDLE_ID, sessionId: SESSION_ID },
          initialMaterials: SUBJECT_MATERIALS,
        },
      });
      expect(decide).toHaveBeenCalledExactlyOnceWith({
        operation: "initialization",
        failureKind: "network",
        attemptNumber: 1,
        error: expect.any(String),
      });
      expect(sleep).toHaveBeenCalledExactlyOnceWith(25);
      expect(harness.submitAgent).toHaveBeenCalledTimes(1);
      expect(harness.restartAgent).not.toHaveBeenCalled();
      expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
      const sampling = await runtime.getSampling(run.samplingIds[0]!);
      expect(sampling.subjectChatId).toBe(first![0].handle.chatId);
      expect(sampling.executionAttempts).toHaveLength(1);
    },
  );

  it("fails without submission or Agent restart when initialization retries are exhausted", async () => {
    const harness = makeHarness();
    vi.mocked(harness.materializeInitialData).mockRejectedValue(new Error("initialization connection failed"));
    const decide = vi.fn<RetryController["decide"]>()
      .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 5 })
      .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 10 })
      .mockResolvedValue({ shouldRetry: false });
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep,
      createRetryController: () => ({ decide }),
    });

    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_TWO });
    const run = await runtime.submit(projectRequest("execution", "initialization-exhausted"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(3);
    const inputs = vi.mocked(harness.materializeInitialData).mock.calls.map(([input]) => input);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[2]).toEqual(inputs[0]);
    expect(decide.mock.calls.map(([input]) => input)).toEqual([1, 2, 3].map((attemptNumber) => ({
      operation: "initialization",
      failureKind: "network",
      attemptNumber,
      error: expect.any(String),
    })));
    expect(sleep.mock.calls).toEqual([[5], [10]]);
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
    expect(harness.collectExecution).not.toHaveBeenCalled();
    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.execution).toEqual({ status: "failed", lastError: "initialization connection failed" });
    expect(sampling.executionAttempts).toHaveLength(1);
    expect(sampling.executionAttempts[0]?.status).toBe("failed");
    await runtime.resume(run.runId);
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(3);
  });

  it("does not retry an unretryable initialization conflict even when its controller allows retries", async () => {
    const harness = makeHarness();
    vi.mocked(harness.materializeInitialData).mockRejectedValue(Object.assign(
      new Error("initialization identity is bound to different input"),
      { retryable: false },
    ));
    const decide = vi.fn<RetryController["decide"]>().mockResolvedValue({ shouldRetry: true, backoffMs: 0 });
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep,
      createRetryController: () => ({ decide }),
    });

    const run = await runtime.submit(projectRequest("execution", "initialization-conflict"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    expect(harness.materializeInitialData).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
  });

  it("counts creation, initialization and Agent restarts independently without reapplying the seed", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ensureAgent).mockRejectedValueOnce(new Error("connection lost after agent ensure"));
    vi.mocked(harness.materializeInitialData).mockRejectedValueOnce(new Error("temporary initialization failure"));
    vi.mocked(harness.submitAgent).mockResolvedValueOnce({
      submissionId: "submission-1",
      status: "failed",
      retryable: true,
    });
    const decide = vi.fn<RetryController["decide"]>()
      .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 0 })
      .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 0 })
      .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 0 })
      .mockResolvedValue({ shouldRetry: false });
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: () => ({ decide }),
    });

    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await runtime.submit(projectRequest("execution", "initialization-then-restart"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

    expect(decide.mock.calls.map(([input]) => input)).toEqual([
      { operation: "creation", failureKind: "network", attemptNumber: 1, error: expect.any(String) },
      { operation: "initialization", failureKind: "network", attemptNumber: 1, error: expect.any(String) },
      { operation: "restart", failureKind: "network", attemptNumber: 1, error: expect.any(String) },
    ]);
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    const [firstEnsure, secondEnsure] = vi.mocked(harness.ensureAgent).mock.calls;
    expect(secondEnsure![0]).toEqual(firstEnsure![0]);
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(harness.materializeInitialData).mock.calls;
    expect(second![0]).toEqual(first![0]);
    expect(harness.restartAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      handle: first![0].handle,
    }));
    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts).toHaveLength(2);
  });

  it("keeps the Subject seed out of the evaluator Session while preserving task evidence and extra fields", async () => {
    const sample = {
      ...makeSample("sample-1"),
      data: {
        ...makeSample("sample-1").data,
        evalPrompt: "  Inspect the page artifacts and score accessibility.  ",
        expectedOutput: { pages: 3 }, labels: ["web"],
      },
    };
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({ plans: makePlans([sample]), harness, store: makeStore() });
    const run = await runtime.submit(projectRequest("pipeline", "independent-evaluator-session"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });
    const inputs = vi.mocked(harness.materializeInitialData).mock.calls.map(([input]) => input);
    const subject = inputs.find((input) => input.handle.role === "subject")!;
    const evaluator = inputs.find((input) => input.handle.role === "evaluator")!;
    expect(subject.data.initialSession).toEqual(sample.data.initialSession);
    expect(subject.data).not.toHaveProperty("evalPrompt");
    expect(subject.data.userPrompt).toBe(sample.data.userPrompt);
    expect(evaluator.data).not.toHaveProperty("initialSession");
    expect(evaluator.data).not.toHaveProperty("evalPrompt");
    expect(evaluator.data).toMatchObject({
      userPrompt: sample.data.evalPrompt,
      initialMaterials: sample.data.evalInitialMaterials,
      expectedOutput: sample.data.expectedOutput,
      labels: sample.data.labels,
    });
    expect(evaluator.idempotencyKey).toBe(`initial-data:${evaluator.handle.chatId}`);
    expect(evaluator.evaluationOutputSchema).toEqual({
      type: "object", properties: { score: { type: "number" } },
    });
    expect(evaluator.handle.chatId).not.toBe(subject.handle.chatId);
    expect(vi.mocked(harness.submitAgent).mock.calls.find(([call]) => call.handle.role === "subject")?.[0].prompt)
      .toBe(sample.data.userPrompt);
    const evaluatorPrompt = vi.mocked(harness.submitAgent).mock.calls
      .find(([call]) => call.handle.role === "evaluator")?.[0].prompt;
    expect(evaluatorPrompt?.startsWith(`${sample.data.evalPrompt}\n\n`)).toBe(true);
    expect(evaluatorPrompt).toContain("/evidence/manifest.json");
    expect(evaluatorPrompt).toContain("/output/result.json");
    const evaluationSubmitIndex = vi.mocked(harness.submitAgent).mock.calls.findIndex(
      ([input]) => input.handle.role === "evaluator",
    );
    expect(vi.mocked(harness.exportEvidence).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(harness.importEvidence).mock.invocationCallOrder[0]!);
    expect(vi.mocked(harness.importEvidence).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(harness.submitAgent).mock.invocationCallOrder[evaluationSubmitIndex]!);
  });

  it("passes one Project JSON Schema to every Evaluator in a multi-Sampling evaluation", async () => {
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({ harness, store: makeStore() });
    runtime.plans.samples = [makeSample("sample-1", { samplingCount: 2 })];
    const execution = await runtime.submit(projectRequest("execution", "schema-multi-execution"));
    await expect(waitForTerminal(runtime, execution.runId)).resolves.toMatchObject({ status: "succeeded" });
    const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    await expect(waitForTerminal(runtime, evaluation.runId)).resolves.toMatchObject({ status: "succeeded" });
    const evaluatorInputs = vi.mocked(harness.materializeInitialData).mock.calls
      .map(([input]) => input).filter((input) => input.handle.role === "evaluator");
    expect(evaluatorInputs).toHaveLength(2);
    for (const input of evaluatorInputs) {
      expect(input.evaluationOutputSchema).toEqual({
        type: "object", properties: { score: { type: "number" } },
      });
      expect(input.data.initialMaterials).toEqual(EVAL_MATERIALS);
      expect(input.data).not.toHaveProperty("evalInitialMaterials");
    }
  });

  it("allows execution-only Data without evalPrompt but rejects evaluation admission", async () => {
    const { evalPrompt: _evalPrompt, ...executionData } = makeSample("sample-1").data;
    const sample = { ...makeSample("sample-1"), data: executionData };
    const harness = makeHarness();
    const store = makeStore();
    const runtime = createAutoResumingRuntime({ plans: makePlans([sample]), harness, store });

    const pipeline = projectRequest("pipeline", "missing-evaluation-prompt");
    await expect(runtime.submit(pipeline)).rejects.toThrow(RuntimeAdmissionConflictError);
    await expect(runtime.submit(pipeline)).rejects.toMatchObject({ reason: "evaluation-prompt" });
    expect(await store.findRunByIdempotencyKey(pipeline.projectId, pipeline.idempotencyKey)).toBeNull();

    const execution = await runtime.submit(projectRequest("execution", "execution-without-evaluation-prompt"));
    await expect(waitForTerminal(runtime, execution.runId)).resolves.toMatchObject({ status: "succeeded" });
    const evaluation = evaluationRequest(execution.samplingIds);
    await expect(runtime.submit(evaluation)).rejects.toThrow(RuntimeAdmissionConflictError);
    await expect(runtime.submit(evaluation)).rejects.toMatchObject({ reason: "evaluation-prompt" });
    expect(await store.findRunByIdempotencyKey(evaluation.projectId, evaluation.idempotencyKey)).toBeNull();
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
  });

  describe("typed caller errors", () => {
    const valid = {
      idempotencyKey: "valid-key", projectId: PROJECT_ID, operation: "execution" as const,
      selector: { all: true as const }, targets: { projectSampleIds: ["sample-1"], samplingIds: [] },
    };
    it.each([
      [{ ...valid, projectId: " " }, "projectId"],
      [{ ...valid, idempotencyKey: " padded " }, "idempotencyKey"],
      [{ ...valid, operation: "start" }, "operation"],
      [{ ...valid, selector: null }, "selector"],
      [{ ...valid, selector: {} }, "selector"],
      [{ ...valid, selector: { datasetIds: [] } }, "selector"],
      [{ ...valid, selector: { all: false } }, "selector.all"],
      [{ ...valid, selector: { samplingIds: ["sampling-1", "sampling-1"] } }, "selector.samplingIds"],
      [{ ...valid, selector: { datasetIds: [" dataset "] } }, "selector.datasetIds"],
      [{ ...valid, targets: null }, "targets"],
      [{ ...valid, targets: { projectSampleIds: ["sample-1"] } }, "targets.samplingIds"],
      [{ ...valid, targets: { projectSampleIds: ["sample-1", "sample-1"], samplingIds: [] } }, "targets.projectSampleIds"],
    ])("rejects invalid Run request %j as input on %s", async (request, field) => {
      const runtime = createAutoResumingRuntime({ harness: makeHarness(), store: makeStore() });
      const submitted = request as unknown as Parameters<typeof runtime.submit>[0];
      await expect(runtime.submit(submitted)).rejects.toThrow(RuntimeInputError);
      await expect(runtime.submit(submitted)).rejects.toMatchObject({ field });
      if (field !== "idempotencyKey" && field !== "projectId" && !field.startsWith("targets")) {
        await expect(runtime.preview(submitted)).rejects.toMatchObject({ name: "RuntimeInputError", field });
      }
    });

    it("rejects empty targets and evaluation targets that list ProjectSamples", async () => {
      const runtime = createAutoResumingRuntime({ harness: makeHarness(), store: makeStore() });
      await expect(runtime.submit({
        ...valid, operation: "pipeline", targets: { projectSampleIds: [], samplingIds: [] },
      })).rejects.toMatchObject({ name: "RuntimeAdmissionConflictError", reason: "empty-targets" });
      await expect(runtime.submit({ ...valid, operation: "evaluation" })).rejects.toMatchObject({
        name: "RuntimeInputError", field: "targets.projectSampleIds",
      });
    });

    it("reports an unknown Project, Dataset, ProjectSample or Sampling as a missing entity", async () => {
      const runtime = createAutoResumingRuntime({ harness: makeHarness(), store: makeStore() });
      await expect(runtime.preview({ projectId: "missing", operation: "execution", selector: { all: true } }))
        .rejects.toMatchObject({ name: "RuntimeEntityNotFoundError", entity: "project", id: "missing" });
      await expect(runtime.submit({ ...valid, projectId: "missing" }))
        .rejects.toMatchObject({ name: "RuntimeEntityNotFoundError", entity: "project" });
      await expect(runtime.preview({ projectId: PROJECT_ID, operation: "execution", selector: { datasetIds: ["other"] } }))
        .rejects.toMatchObject({ entity: "dataset", id: "other" });
      await expect(runtime.preview({ projectId: PROJECT_ID, operation: "execution", selector: { projectSampleIds: ["other"] } }))
        .rejects.toMatchObject({ entity: "project-sample", id: "other" });
      await expect(runtime.submit({ ...valid, targets: { projectSampleIds: ["other"], samplingIds: [] } }))
        .rejects.toMatchObject({ entity: "project-sample", id: "other" });
      await expect(runtime.preview({ projectId: PROJECT_ID, operation: "execution", selector: { samplingIds: ["other"] } }))
        .rejects.toMatchObject({ entity: "sampling", id: "other" });
      await expect(runtime.submit({ ...valid, targets: { projectSampleIds: [], samplingIds: ["other"] } }))
        .rejects.toMatchObject({ entity: "sampling", id: "other" });
    });

    it.each(["unknown", "unsuccessful"] as const)(
      "rejects an %s Sampling selection for evaluation",
      async (selection) => {
        const harness = makeHarness();
        vi.mocked(harness.collectExecution).mockResolvedValueOnce({
          samplingId: "ignored", status: "failed", error: "subject failed",
          artifacts: [], trajectory: { trajectoryId: "trajectory-1", source: "subject", path: "/trajectory.jsonl" },
        });
        const store = makeStore();
        const runtime = createAutoResumingRuntime({ harness, store });
        const execution = await runtime.submit(projectRequest("execution", "unavailable-selection"));
        await waitForTerminal(runtime, execution.runId);
        const samplingIds = selection === "unknown" ? ["missing-sampling"] : execution.samplingIds;
        const request = evaluationRequest(samplingIds);
        await expect(runtime.submit(request)).rejects.toMatchObject(selection === "unknown"
          ? { name: "RuntimeEntityNotFoundError", entity: "sampling" }
          : { name: "RuntimeAdmissionConflictError", reason: "sampling-unavailable" });
        await expect(runtime.preview({ projectId: PROJECT_ID, operation: "evaluation", selector: { samplingIds } }))
          .rejects.toMatchObject(selection === "unknown" ? { entity: "sampling" } : { reason: "sampling-unavailable" });
        expect(await store.findRunByIdempotencyKey(request.projectId, request.idempotencyKey)).toBeNull();
      },
    );

    it("reports unknown Run, Sampling and Evaluation reads as missing entities", async () => {
      const store = makeStore();
      const runtime = createAutoResumingRuntime({ harness: makeHarness(), store });
      const resumer = createTestResumer(store, makeHarness());
      await expect(runtime.getRun("missing")).rejects.toMatchObject({ name: "RuntimeEntityNotFoundError", entity: "run" });
      await expect(runtime.getSampling("missing")).rejects.toMatchObject({ entity: "sampling", id: "missing" });
      await expect(runtime.getEvaluation("missing")).rejects.toMatchObject({ entity: "evaluation", id: "missing" });
      await expect(resumer.resume("missing")).rejects.toThrow(RuntimeEntityNotFoundError);
      await expect(resumer.interrupt("missing")).rejects.toThrow(RuntimeEntityNotFoundError);
      await expect(resumer.stop("missing")).rejects.toThrow(RuntimeEntityNotFoundError);
    });
  });

  it("continues the Agent Session after a restart without reapplying its seed", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValueOnce({
      submissionId: "submission-1",
      status: "failed",
      retryable: true,
    });
    const runtime = createAutoResumingRuntime({ harness, store: makeStore(), sleep: async () => undefined });
    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await runtime.submit(projectRequest("execution", "keep-restored-session"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: "Execute sample-1" }));
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
  });

  it.each(["sp", "codex", "cc"] as const)(
    "runs the selected %s framework through the same hosted lifecycle",
    async (framework) => {
      const harness = makeHarness();
      const store = makeStore();
      vi.mocked(harness.submitAgent).mockResolvedValueOnce({
        submissionId: "submission-1",
        status: "queued",
      });
      vi.mocked(harness.waitForSubmission).mockResolvedValueOnce(makeSubmission());
      const runtime = createAutoResumingRuntime({
        plans: makePlans(undefined, { execution: executionPlan({ harness: subjectHarness(framework) }) }),
        harness,
        store,
        sleep: async () => undefined,
      });

      const run = await runtime.submit(projectRequest("execution", `framework-${framework}`));
      await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
        status: "succeeded",
      });

      expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
      expect(harness.ensureAgent).toHaveBeenCalledWith(expect.objectContaining({
        role: "subject",
        framework,
        agentConfig: SUBJECT,
      }));
      const expectedHandle = expect.objectContaining({
        role: "subject",
        framework,
        samplingId: run.samplingIds[0],
      });
      expect(harness.materializeInitialData).toHaveBeenCalledWith(expect.objectContaining({
        handle: expectedHandle,
      }));
      expect(harness.submitAgent).toHaveBeenCalledWith(expect.objectContaining({
        handle: expectedHandle,
      }));
      expect(harness.waitForSubmission).toHaveBeenCalledWith(expect.objectContaining({
        handle: expectedHandle,
      }));
      expect(harness.collectExecution).toHaveBeenCalledWith(expect.objectContaining({
        handle: expectedHandle,
      }));
      const record = await store.getRun(run.runId);
      expect(record).toMatchObject({ operation: "execution", planDigests: { execution: expect.any(String) } });
      expect(record).not.toHaveProperty("config");
    },
  );

  it.each(["codex", "cc"] as const)(
    "evaluates %s execution with a separate SP evaluator in the pipeline",
    async (framework) => {
      const harness = makeHarness();
      const store = makeStore();
      const runtime = createAutoResumingRuntime({
        plans: makePlans(undefined, { execution: executionPlan({ harness: subjectHarness(framework) }) }),
        harness,
        store,
        sleep: async () => undefined,
      });

      const run = await runtime.submit(projectRequest("pipeline", `pipeline-${framework}`));
      await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
        status: "succeeded",
      });

      expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
      expect(harness.ensureAgent).toHaveBeenNthCalledWith(1, expect.objectContaining({
        role: "subject",
        framework,
        agentConfig: SUBJECT,
      }));
      expect(harness.ensureAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
        role: "evaluator",
        framework: "sp",
        agentConfig: EVALUATOR,
        evaluationId: expect.any(String),
      }));
      expect(harness.ensureAgent).toHaveBeenNthCalledWith(2, expect.not.objectContaining({
        evaluationWorkspace: expect.anything(),
      }));
      const sampling = await store.getSampling(run.samplingIds[0]!);
      expect(harness.importEvidence).toHaveBeenCalledWith(expect.objectContaining({
        handle: expect.objectContaining({ role: "evaluator", evaluationId: expect.any(String) }),
        root: "/evidence",
        evidence: expect.objectContaining({ ref: sampling?.evidence }),
      }));
      await expect(store.getRun(run.runId)).resolves.toMatchObject({
        operation: "pipeline",
        planDigests: { execution: expect.any(String), evaluation: expect.any(String) },
      });
    },
  );

  it("rejects an Agent handle provisioned with a different framework", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ensureAgent).mockImplementation(async (input) => ({
      role: input.role,
      ownerUserId: input.agentConfig.ownerUserId,
      framework: "sp",
      samplingId: input.samplingId,
      chatId: input.chatId,
    }));
    const runtime = createAutoResumingRuntime({
      plans: makePlans(undefined, { execution: executionPlan({ harness: subjectHarness("codex") }) }),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ creation: 1 }),
    });

    const run = await runtime.submit(projectRequest("execution", "wrong-framework"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
    expect(harness.materializeInitialData).not.toHaveBeenCalled();
    expect(harness.submitAgent).not.toHaveBeenCalled();
  });

  it("rejects an Agent handle belonging to another user before initializing it", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ensureAgent).mockImplementation(async (input) => ({
      role: input.role,
      ownerUserId: "another-user",
      framework: input.framework,
      samplingId: input.samplingId,
      chatId: input.chatId,
    }));
    const runtime = createAutoResumingRuntime({
      harness, store: makeStore(), sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ creation: 1 }),
    });
    const run = await runtime.submit(projectRequest("execution", "wrong-chat-owner"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
    expect(harness.materializeInitialData).not.toHaveBeenCalled();
    expect(harness.submitAgent).not.toHaveBeenCalled();
  });

  it("rejects an evaluator Chat that did not bind its Evaluation ID", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ensureAgent).mockImplementation(async (input) => ({
      role: input.role,
      ownerUserId: input.agentConfig.ownerUserId,
      framework: input.framework,
      samplingId: input.samplingId,
      chatId: input.chatId,
    }));
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.submit(projectRequest("pipeline", "missing-evaluator-evaluation-id"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
    expect(harness.importEvidence).not.toHaveBeenCalled();
    expect(vi.mocked(harness.submitAgent).mock.calls.filter(
      ([input]) => input.handle.role === "evaluator",
    )).toHaveLength(0);
  });

  it.each(["codex", "cc"] as const)(
    "retains %s creation facts and handle when ensuring and restarting an Agent",
    async (framework) => {
      const harness = makeHarness();
      vi.mocked(harness.ensureAgent).mockRejectedValueOnce(new Error("ensure response lost"));
      vi.mocked(harness.submitAgent).mockResolvedValueOnce({
        submissionId: "submission-1",
        status: "failed",
        retryable: true,
      });
      const runtime = createAutoResumingRuntime({
        plans: makePlans(undefined, { execution: executionPlan({ harness: subjectHarness(framework) }) }),
        harness,
        store: makeStore(),
        sleep: async () => undefined,
        createRetryController: makeRetryControllerFactory({ creation: 1, restart: 1 }),
      });

      const run = await runtime.submit(projectRequest("execution", `retry-${framework}`));
      await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

      const ensureCalls = vi.mocked(harness.ensureAgent).mock.calls;
      expect(ensureCalls).toHaveLength(2);
      expect(ensureCalls[0]?.[0]).toMatchObject({ framework });
      expect(ensureCalls[1]?.[0]).toEqual(ensureCalls[0]?.[0]);
      expect(harness.restartAgent).toHaveBeenCalledTimes(1);
      const submitInput = vi.mocked(harness.submitAgent).mock.calls[0]![0];
      const restartInput = vi.mocked(harness.restartAgent).mock.calls[0]![0];
      expect(restartInput.handle).toEqual(submitInput.handle);
      expect(restartInput.handle.framework).toBe(framework);
    },
  );

  it("replays the original Run for its key without reading the current plan again", async () => {
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({
      plans: makePlans(undefined, { execution: executionPlan({ harness: subjectHarness("codex") }) }),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const run = await runtime.submit(projectRequest("execution", "framework-key"));
    await waitForTerminal(runtime, run.runId);

    runtime.plans.execution = executionPlan({ harness: subjectHarness("cc") });
    const getProjectPlan = vi.spyOn(runtime.plans, "getProjectPlan");
    await expect(runtime.submit(projectRequest("execution", "framework-key"))).resolves.toEqual(run);
    expect(getProjectPlan).not.toHaveBeenCalled();
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
  });

  it("passes execution harness runtime options through the subject lifecycle", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValueOnce({
      submissionId: "submission-1",
      status: "queued",
      accepted: true,
      retryable: false,
    });
    vi.mocked(harness.waitForSubmission).mockResolvedValueOnce(makeSubmission());
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    runtime.plans.execution = executionPlan({ harness: subjectHarness("sp", EXECUTION_RUNTIME) });
    const run = await runtime.submit(projectRequest("execution", "execution-runtime-options"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });

    expect(harness.ensureAgent).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EXECUTION_RUNTIME,
    }));
    expect(harness.materializeInitialData).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EXECUTION_RUNTIME,
    }));
    expect(harness.submitAgent).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EXECUTION_RUNTIME,
    }));
    expect(harness.waitForSubmission).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EXECUTION_RUNTIME,
    }));
    expect(harness.collectExecution).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EXECUTION_RUNTIME,
    }));
    expect(harness.collectAgentResources).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EXECUTION_RUNTIME,
    }));
  });

  it("passes evaluation harness runtime options through the evaluator lifecycle", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => (
      handle.role === "evaluator"
        ? {
            submissionId: "submission-1",
            status: "queued",
            accepted: true,
            retryable: false,
          }
        : makeSubmission()
    ));
    vi.mocked(harness.waitForSubmission).mockResolvedValueOnce(makeSubmission());
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const execution = await runtime.submit(projectRequest("execution", "evaluation-runtime-execution"));
    await waitForTerminal(runtime, execution.runId);
    runtime.plans.evaluation = evaluationPlan({ evaluationHarness: { ...evaluationPlan().evaluationHarness, runtime: EVALUATION_RUNTIME } });
    const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    await expect(waitForTerminal(runtime, evaluation.runId)).resolves.toMatchObject({
      status: "succeeded",
    });

    expect(harness.ensureAgent).toHaveBeenCalledWith(expect.objectContaining({
      role: "evaluator",
      runtime: EVALUATION_RUNTIME,
    }));
    expect(harness.materializeInitialData).toHaveBeenCalledWith(expect.objectContaining({
      handle: expect.objectContaining({ role: "evaluator" }),
      runtime: EVALUATION_RUNTIME,
    }));
    expect(harness.importEvidence).toHaveBeenCalledWith(expect.objectContaining({
      handle: expect.objectContaining({ role: "evaluator" }),
      runtime: EVALUATION_RUNTIME,
    }));
    expect(harness.submitAgent).toHaveBeenCalledWith(expect.objectContaining({
      handle: expect.objectContaining({ role: "evaluator" }),
      runtime: EVALUATION_RUNTIME,
    }));
    expect(harness.waitForSubmission).toHaveBeenCalledWith(expect.objectContaining({
      handle: expect.objectContaining({ role: "evaluator" }),
      runtime: EVALUATION_RUNTIME,
    }));
    expect(harness.collectEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      runtime: EVALUATION_RUNTIME,
    }));
    expect(harness.collectAgentResources).toHaveBeenCalledWith(expect.objectContaining({
      handle: expect.objectContaining({ role: "evaluator" }),
      runtime: EVALUATION_RUNTIME,
    }));
  });

  it("persists operation, targets and plan digests without a configuration body for every operation", async () => {
    const store = makeStore();
    const runtime = createAutoResumingRuntime({
      harness: makeHarness(),
      store,
      sleep: async () => undefined,
    });
    const plan = (await runtime.plans.getProjectPlan(PROJECT_ID))!;

    const execution = await runtime.submit(projectRequest("execution", "plan-digest-execution"));
    const executionRecord = await store.getRun(execution.runId);
    expect(executionRecord).toMatchObject({
      operation: "execution", phases: ["execution"], selector: { all: true },
      targets: { projectSampleIds: ["sample-1"], samplingIds: [] },
      planDigests: { execution: plan.executionPlanDigest }, sourceCommit: SOURCE_COMMIT,
    });
    expect(executionRecord?.planDigests).not.toHaveProperty("evaluation");
    expect(executionRecord).not.toHaveProperty("config");
    await expect(runtime.getRun(execution.runId)).resolves.toMatchObject({
      operation: "execution", selector: { all: true }, targets: executionRecord!.targets,
    });

    await waitForTerminal(runtime, execution.runId);
    const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    await expect(store.getRun(evaluation.runId)).resolves.toMatchObject({
      operation: "evaluation", phases: ["evaluation"], samplingIds: execution.samplingIds,
      selector: { samplingIds: execution.samplingIds },
      targets: { projectSampleIds: [], samplingIds: execution.samplingIds },
      planDigests: { execution: plan.executionPlanDigest, evaluation: plan.evaluation!.digest },
    });

    await waitForTerminal(runtime, evaluation.runId);
    const pipeline = await runtime.submit(projectRequest("pipeline", "plan-digest-pipeline"));
    await expect(store.getRun(pipeline.runId)).resolves.toMatchObject({
      operation: "pipeline", phases: ["execution", "evaluation"],
      planDigests: { execution: plan.executionPlanDigest, evaluation: plan.evaluation!.digest },
    });
  });

  it("keeps static sample input out of persisted sampling records", async () => {
    const runtime = createAutoResumingRuntime({
      harness: makeHarness(),
      store: makeStore(),
      sleep: async () => undefined,
    });
    runtime.plans.samples = [makeSample("sample-1", { samplingCount: 2 })];
    const run = await runtime.submit(projectRequest("execution", "sample-record-request"));
    await waitForTerminal(runtime, run.runId);

    const records = await Promise.all(
      run.samplingIds.map((samplingId) => runtime.getSampling(samplingId)),
    );
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.projectSampleId === "sample-1")).toBe(true);
    expect(records.every((record) => !Object.prototype.hasOwnProperty.call(record, "sample"))).toBe(true);
  });

  it("returns the original run when the same request is retried", async () => {
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const request = projectRequest("execution", "request-1");

    const firstRun = await runtime.submit(request);
    const retriedRun = await runtime.submit(request);

    expect(retriedRun).toEqual(firstRun);
    await expect(waitForTerminal(runtime, firstRun.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
  });

  it("returns the original run when a retry uses the same idempotency key", async () => {
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const firstRun = await runtime.submit(projectRequest("execution", "run-key-1"));
    const retriedRun = await runtime.submit(projectRequest("execution", "run-key-1"));

    expect(retriedRun).toEqual(firstRun);
    await expect(waitForTerminal(runtime, firstRun.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
  });

  it("rejects a key reused for another Run operation in the same Project", async () => {
    const runtime = createAutoResumingRuntime({
      harness: makeHarness(),
      store: makeStore(),
      sleep: async () => undefined,
    });
    await runtime.submit(projectRequest("execution", "run-key-1"));

    await expect(
      runtime.submit(projectRequest("pipeline", "run-key-1")),
    ).rejects.toThrow(RuntimeRunIdentityConflictError);
  });

  it("rejects a reused idempotency key when request facts change", async () => {
    const runtime = createAutoResumingRuntime({
      plans: makePlans([makeSample("sample-1"), makeSample("sample-2")]),
      harness: makeHarness(),
      store: makeStore(),
      sleep: async () => undefined,
    });
    const first = await runtime.submit(projectRequest("execution", "run-key-1", ["sample-1", "sample-2"]));
    const request = {
      idempotencyKey: "run-key-1", projectId: PROJECT_ID, operation: "execution" as const,
      selector: { all: true as const }, targets: { projectSampleIds: ["sample-1", "sample-2"], samplingIds: [] },
    };
    await expect(runtime.submit(request)).resolves.toEqual(first);
    await expect(runtime.submit({ ...request, targets: { projectSampleIds: ["sample-2", "sample-1"], samplingIds: [] } }))
      .rejects.toThrow(RuntimeRunIdentityConflictError);
    await expect(runtime.submit({ ...request, selector: { datasetIds: ["dataset-1"] } }))
      .rejects.toThrow(RuntimeRunIdentityConflictError);
    await expect(runtime.submit({ ...request, targets: { projectSampleIds: ["sample-1"], samplingIds: [] } }))
      .rejects.toThrow(RuntimeRunIdentityConflictError);
  });

  it("admits one run when identical requests race before plan resolution", async () => {
    const harness = makeHarness();
    let releasePlan!: () => void;
    const planReady = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });
    const plans = makePlans();
    const getProjectPlan = plans.getProjectPlan.bind(plans);
    plans.getProjectPlan = async (projectId) => {
      await planReady;
      return getProjectPlan(projectId);
    };
    const runtime = createAutoResumingRuntime({
      plans,
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const request = projectRequest("execution", "run-key-1");

    const firstAdmission = runtime.submit(request);
    const secondAdmission = runtime.submit(request);
    releasePlan();
    const [firstRun, secondRun] = await Promise.all([firstAdmission, secondAdmission]);

    expect(secondRun).toEqual(firstRun);
    await expect(waitForTerminal(runtime, firstRun.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
  });

  it("returns the original pipeline run when the request is retried", async () => {
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const request = projectRequest("pipeline", "pipeline-key-1");

    const firstRun = await runtime.submit(request);
    const retriedRun = await runtime.submit(request);

    expect(retriedRun).toEqual(firstRun);
    await expect(waitForTerminal(runtime, firstRun.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
  });

  it("keeps evaluation state absent when only execution is requested", async () => {
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.submit(projectRequest("execution", "test-request"));
    await waitForTerminal(runtime, run.runId);

    await expect(runtime.getSampling(run.samplingIds[0]!)).resolves.toMatchObject({
      execution: { status: "succeeded" },
    });
    await expect(runtime.getSampling(run.samplingIds[0]!)).resolves.not.toHaveProperty("sample");
    await expect(runtime.getSampling(run.samplingIds[0]!)).resolves.not.toHaveProperty("evaluation");
  });

  it("retries execution output collection without restarting a completed agent", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectExecution)
      .mockRejectedValueOnce(new Error("temporary artifact fetch failure"));
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ collection: 1 }),
    });

    const run = await runtime.submit(projectRequest("execution", "test-request"));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.submitAgent).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
  });

  it("recovers a transient output collection failure with the production retry controller", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectExecution)
      .mockRejectedValueOnce(Object.assign(new Error("service temporarily unavailable"), { retryable: true }));
    const store = makeStore({ plans: makePlans(undefined, { execution: executionPlan({ retryPolicy: DEFAULT_RETRY_POLICY }) }) });
    const runtime = createRuntime({ harness, store, sleep: async () => undefined, createRetryController: createProductionRetryController });
    const run = await runtime.submit(projectRequest("execution", "default-collection-retry"));

    await runtime.resume(run.runId);

    expect((await runtime.getSampling(run.samplingIds[0]!)).execution).toEqual({ status: "succeeded" });
    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("logs payload-free pass, attempt, retry, resource and evidence events with their Run members", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectExecution)
      .mockRejectedValueOnce(Object.assign(new Error("service temporarily unavailable"), { retryable: true }));
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const store = makeStore({ plans: makePlans(undefined, { execution: executionPlan({ retryPolicy: DEFAULT_RETRY_POLICY }) }) });
    const events: { readonly name: string; readonly [field: string]: unknown }[] = [];
    const runtime = createRuntime({
      harness, store, sleep: async () => undefined, createRetryController: createProductionRetryController,
      log: (event) => events.push(event),
    });
    const run = await runtime.submit(projectRequest("pipeline", "runtime-log-events"));
    const samplingId = run.samplingIds[0]!;

    await runtime.resume(run.runId);

    const evaluationId = (await store.getRun(run.runId))!.evaluationIds[0]!;
    const member = { runId: run.runId, stage: "execution", samplingId };
    const evaluator = { runId: run.runId, stage: "evaluation", samplingId, evaluationId };
    expect(events).toContainEqual({
      ...member, name: "stage_attempt", attemptNumber: 1, attemptId: expect.any(String), status: "running",
    });
    expect(events).toContainEqual({
      ...member, name: "stage_attempt", attemptNumber: 1, attemptId: expect.any(String), submissionId: expect.any(String),
      status: "completed", durationMs: expect.any(Number),
    });
    expect(events).toContainEqual(expect.objectContaining({ ...evaluator, name: "stage_attempt", status: "completed" }));
    expect(events).toContainEqual({
      ...member, name: "operation_retry", operation: "collection", attemptNumber: 1, failureKind: "network",
      error: "service temporarily unavailable", backoffMs: 250,
    });
    expect(events).toContainEqual({
      ...member, name: "resource_wait", chatId: expect.any(String), idempotencyKey: `execution:${samplingId}`,
      submissionId: expect.any(String), checks: 1, finalized: true, durationMs: expect.any(Number),
    });
    expect(events).toContainEqual(expect.objectContaining({
      ...evaluator, name: "resources_collected", finalized: true, usageEvents: 1, nativeRecords: 5, billingSettlements: 2, creditsTotal: 20,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      ...member, name: "evidence_export", passes: 1, outcome: "stored", filesStored: 1, filesTotal: 1,
      bytes: expect.any(Number), trajectoryParts: 1, trajectoryRecords: 1, trajectoryDone: true, omitted: {},
    }));
    expect(events.at(-1)).toEqual({
      name: "run_pass_summary", runId: run.runId, operation: "pipeline",
      execution: { succeeded: 1 }, evaluation: { succeeded: 1 },
      evidencePending: 0, collectionPending: 0, observationPending: 0, resourcesPending: 0, durationMs: expect.any(Number),
    });
    const serialized = JSON.stringify(events);
    for (const payload of ["Execute sample-1", "inputTokens", "providerMetadata", "turn.started", "contentBase64", "token"]) {
      expect(serialized).not.toContain(payload);
    }
  });

  it("keeps a completed Subject pending when evidence export is temporarily unavailable", async () => {
    const harness = makeHarness();
    vi.mocked(harness.exportEvidence).mockRejectedValue(
      Object.assign(new Error("service temporarily unavailable"), { retryable: true }),
    );
    const store = makeStore({ plans: makePlans(undefined, { execution: executionPlan({ retryPolicy: DEFAULT_RETRY_POLICY }) }) });
    const runtime = createRuntime({ harness, store, sleep: async () => undefined, createRetryController: createProductionRetryController });
    const run = await runtime.submit(projectRequest("execution", "pending-evidence-export"));

    await runtime.resume(run.runId);

    const pending = await runtime.getSampling(run.samplingIds[0]!);
    expect(pending.execution).toEqual(expect.objectContaining({ status: "retrying", evidencePending: true }));
    expect(pending.artifacts).toEqual([{ artifactId: "artifact-1", kind: "project", path: "/eval/output" }]);
    expect(harness.exportEvidence).toHaveBeenCalledTimes(11);

    vi.mocked(harness.exportEvidence).mockImplementation(async ({ handle }) => (
      exportedEvidence({ samplingId: handle.samplingId, chatId: handle.chatId })
    ));

    await runtime.resume(run.runId);

    expect((await runtime.getSampling(run.samplingIds[0]!)).execution).toEqual({ status: "succeeded" });
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("retries transient resource reads for execution and evaluation without rerunning either Agent", async () => {
    const harness = makeHarness();
    const transientFailures = new Set<string>();
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      if (!transientFailures.has(input.handle.role)) {
        transientFailures.add(input.handle.role);
        throw Object.assign(new Error("service temporarily unavailable"), { retryable: true });
      }
      return makeResources(input);
    });
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore({ plans: makePlans(undefined, {
        execution: executionPlan({ retryPolicy: DEFAULT_RETRY_POLICY }),
        evaluation: evaluationPlan({ retryPolicy: DEFAULT_RETRY_POLICY }),
      }) }),
      sleep: async () => undefined,
      createRetryController: createProductionRetryController,
    });
    const run = await runtime.submit(projectRequest("pipeline", "default-resource-retry"));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(4);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect((await runtime.getSampling(run.samplingIds[0]!)).executionAttempts[0]!.resources?.status).toBe("collected");
    const evaluationId = (await runtime.getRun(run.runId)).evaluationIds[0]!;
    const evaluation = await runtime.getEvaluation(evaluationId);
    expect(evaluation.attempts[0]!.resources?.status).toBe("collected");
  });

  it("does not restart a completed Agent when output collection retries are exhausted", async () => {
    const harness = makeHarness();
    const store = makeStore();
    vi.mocked(harness.collectExecution).mockRejectedValue(
      new Error("artifact storage unavailable"),
    );
    const runtime = createAutoResumingRuntime({
      harness,
      store,
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ collection: 1 }),
    });

    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_TWO });
    const run = await runtime.submit(projectRequest("execution", "test-request"));

    await expect.poll(async () => (await runtime.getSampling(run.samplingIds[0]!)).execution.evidencePending).toBe(true);
    expect((await runtime.getRun(run.runId)).status).toBe("retrying");
    expect(harness.submitAgent).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
    vi.mocked(harness.collectExecution).mockResolvedValue({
      samplingId: run.samplingIds[0]!, status: "succeeded",
      artifacts: [{ artifactId: "recovered", kind: "project", path: "/eval/output" }],
      trajectory: { trajectoryId: "full-trajectory", source: "subject", path: "/eval/trajectory.jsonl" },
    });
    await runtime.resume(run.runId);
    expect((await runtime.getRun(run.runId)).status).toBe("succeeded");
    expect(harness.submitAgent).toHaveBeenCalledOnce();
  });

  it("does not restart an agent when output collection returns a failed result", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectExecution).mockResolvedValue({
      samplingId: "sample-1",
      status: "failed",
      artifacts: [],
      trajectory: {
        trajectoryId: "trajectory-1",
        source: "subject",
        path: "/eval/trajectory.jsonl",
      },
      error: "artifact collection failed",
    });
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_TWO });
    const run = await runtime.submit(projectRequest("execution", "test-request"));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "failed",
    });
    expect(harness.restartAgent).not.toHaveBeenCalled();
    await expect(runtime.getSampling(run.samplingIds[0]!)).resolves.toMatchObject({
      artifacts: [],
      trajectory: { trajectoryId: "trajectory-1", source: "subject" },
    });
  });

  it("preserves Subject artifacts and complete trajectory after a failed Submission", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValue({
      submissionId: "submission-1",
      status: "failed",
      error: "agent task failed",
      retryable: true,
    });
    vi.mocked(harness.collectExecution).mockImplementation(async ({ handle }) => ({
      samplingId: handle.samplingId,
      status: "failed",
      artifacts: [{ artifactId: "partial-project", kind: "project", path: "/eval/partial" }],
      trajectory: { trajectoryId: "full-trajectory", source: "subject", path: "/eval/trajectory.jsonl" },
    }));
    const runtime = createAutoResumingRuntime({ harness, store: makeStore() });

    const run = await runtime.submit(projectRequest("execution", "failed-subject-evidence"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    expect(harness.collectExecution).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      handle: expect.objectContaining({ role: "subject", chatId: expect.any(String) }),
    }));
    await expect(runtime.getSampling(run.samplingIds[0]!)).resolves.toMatchObject({
      execution: { status: "failed", lastError: "agent task failed" },
      artifacts: [{ artifactId: "partial-project" }],
      trajectory: { trajectoryId: "full-trajectory", source: "subject" },
    });
  });

  it("keeps the original failed Submission error when evidence collection is unavailable", async () => {
    const harness = makeHarness();
    const onError = vi.fn();
    const store = makeStore();
    vi.mocked(harness.submitAgent).mockResolvedValue({
      submissionId: "submission-1",
      status: "failed",
      error: "agent task failed",
      retryable: true,
    });
    vi.mocked(harness.collectExecution).mockRejectedValue(new Error("workspace unavailable"));
    const runtime = createAutoResumingRuntime({ harness, store, onError });

    const run = await runtime.submit(projectRequest("execution", "failed-subject-evidence-unavailable"));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    await expect(runtime.getSampling(run.samplingIds[0]!)).resolves.toMatchObject({
      execution: { status: "retrying", lastError: "agent task failed", evidencePending: true },
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("workspace unavailable"),
    }), { runId: run.runId, stage: "execution", samplingId: run.samplingIds[0] });
    vi.mocked(harness.collectExecution).mockResolvedValue({
      samplingId: run.samplingIds[0]!, status: "failed",
      artifacts: [{ artifactId: "partial", kind: "project", path: "/eval/partial" }],
      trajectory: { trajectoryId: "full-trajectory", source: "subject", path: "/eval/trajectory.jsonl" },
    });
    await createTestResumer(store, harness).resume(run.runId);
    await expect(runtime.getSampling(run.samplingIds[0]!)).resolves.toMatchObject({
      execution: { status: "failed", lastError: "agent task failed" },
      artifacts: [{ artifactId: "partial" }],
      trajectory: { trajectoryId: "full-trajectory" },
    });
    expect(harness.submitAgent).toHaveBeenCalledOnce();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("does not restart an agent when submission status cannot be confirmed", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValue({
      submissionId: "submission-1",
      status: "queued",
      retryable: true,
    });
    vi.mocked(harness.waitForSubmission).mockRejectedValue(new Error("status service unavailable"));
    vi.mocked(harness.inspectAgentOperation).mockRejectedValue(new Error("inspection service unavailable"));
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_TWO });
    const run = await runtime.submit(projectRequest("execution", "test-request"));

    // Unknown status stays recoverable for bounded passes, then fails without a restart.
    await vi.waitFor(async () => expect((await runtime.getSampling(run.samplingIds[0]!)).execution)
      .toMatchObject({ status: "retrying", observationPending: { passes: 1 } }));
    for (let pass = 2; pass <= OBSERVATION_MAX_PASSES; pass += 1) await runtime.resume(run.runId);
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.submitAgent).toHaveBeenCalledOnce();
    expect(harness.collectExecution).not.toHaveBeenCalled();
  });

  it("restarts only after status observation confirms a failed submission", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValue({
      submissionId: "submission-1",
      status: "queued",
      retryable: true,
    });
    vi.mocked(harness.waitForSubmission).mockResolvedValue({
      submissionId: "submission-1",
      status: "failed",
      retryable: true,
      error: "temporary agent failure",
    });
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await runtime.submit(projectRequest("execution", "test-request"));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.restartAgent).toHaveBeenCalledTimes(1);
  });

  it("evaluates completed executions in new evaluator submissions", async () => {
    const harness = makeHarness();
    const plans = makePlans();
    const getSamples = vi.spyOn(plans, "getProjectSamples");
    const store = makeStore();
    const runtime = createAutoResumingRuntime({
      plans,
      harness,
      store,
      sleep: async () => undefined,
    });
    const execution = await runtime.submit(projectRequest("execution", "test-request"));
    await waitForTerminal(runtime, execution.runId);

    const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    const snapshot = await waitForTerminal(runtime, evaluation.runId);
    const evaluationRecord = await runtime.getEvaluation(snapshot.evaluationIds[0]!);

    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.evaluationIds).toHaveLength(1);
    expect(evaluationRecord.samplingId).toBe(execution.samplingIds[0]);
    expect(evaluationRecord.evaluator).toEqual(EVALUATOR);
    expect(evaluationRecord.status).toEqual({ status: "succeeded" });
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(1);
    expect(getSamples).toHaveBeenCalledWith(PROJECT_ID, ["sample-1"]);
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(2);
    const sampling = await runtime.getSampling(execution.samplingIds[0]!);
    const stored = await saved(store, execution.samplingIds[0]!);
    expect(sampling.subjectChatId).toEqual(expect.any(String));
    expect(evaluationRecord.chatId).toEqual(expect.any(String));
    expect(evaluationRecord.chatId).not.toBe(sampling.subjectChatId);
    const evidence = stored.evidence!;
    expect(evidence.evidenceId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const importInput = vi.mocked(harness.importEvidence).mock.calls[0]?.[0];
    expect(importInput?.idempotencyKey).toBe(`evidence:${evidence.evidenceId}:${evaluationRecord.evaluationId}`);
    expect(importInput?.handle.chatId).toBe(evaluationRecord.chatId);
    expect(importInput?.evidence.manifest.artifacts).toEqual([expect.objectContaining({ path: "/index.html" })]);
    expect(harness.ensureAgent).toHaveBeenCalledWith(expect.objectContaining({
      chatId: evaluationRecord.chatId,
      evaluationId: evaluationRecord.evaluationId,
    }));
    expect(sampling).toMatchObject({
      execution: { status: "succeeded" },
    });
    expect(sampling).not.toHaveProperty("evaluation");
  });

  it("replaces only the selected Sampling's EvaluationRecord when it is evaluated again", async () => {
    const harness = makeHarness();
    const store = makeStore();
    const runtime = createAutoResumingRuntime({
      harness,
      store,
      sleep: async () => undefined,
    });
    const execution = await runtime.submit(projectRequest("execution", "repeated-evaluation-execution"));
    await waitForTerminal(runtime, execution.runId);

    const firstEvaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    const firstSnapshot = await waitForTerminal(runtime, firstEvaluation.runId);

    const secondEvaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    const secondSnapshot = await waitForTerminal(runtime, secondEvaluation.runId);
    const evaluations = await runtime.listEvaluations(execution.samplingIds[0]!);

    expect(firstSnapshot.evaluationIds).not.toEqual(secondSnapshot.evaluationIds);
    expect(evaluations.map(({ evaluationId }) => evaluationId)).toEqual([secondSnapshot.evaluationIds[0]]);
    await expect(store.getEvaluation(firstSnapshot.evaluationIds[0]!)).resolves.toBeNull();
    expect((await store.getRun(firstEvaluation.runId))?.evaluationIds).toEqual([]);
    // Both Evaluations read the same frozen bundle; the Subject is exported only once.
    expect(harness.exportEvidence).toHaveBeenCalledTimes(1);
    const imports = vi.mocked(harness.importEvidence).mock.calls.map(([input]) => input);
    expect(imports).toHaveLength(2);
    expect(imports[1]?.evidence.ref).toEqual(imports[0]?.evidence.ref);
    expect(imports.map(({ handle }) => handle.evaluationId)).toEqual([
      firstSnapshot.evaluationIds[0],
      secondSnapshot.evaluationIds[0],
    ]);
    const evaluatorIds = vi.mocked(harness.ensureAgent).mock.calls
      .map(([input]) => input)
      .filter((input) => input.role === "evaluator")
      .map((input) => input.evaluationId);
    expect(evaluatorIds).toEqual([firstSnapshot.evaluationIds[0], secondSnapshot.evaluationIds[0]]);
    await expect(runtime.getSampling(execution.samplingIds[0]!)).resolves.not.toHaveProperty(
      "evaluation",
    );
  });

  it("admits execution, evaluation and pipeline Runs without a Harness credential", async () => {
    const store = makeStore();
    const getSamplings = vi.spyOn(store, "getSamplings");
    const admission = createTestAdmission(store);
    expect("resume" in admission).toBe(false);
    const execution = await admission.submit(projectRequest("execution", "admission-only-execution"));
    const sampling = await store.getSampling(execution.samplingIds[0]!);
    expect(sampling?.execution.status).toBe("queued");
    await store.updateSampling({ ...sampling!, execution: { status: "succeeded" } }, sampling!);

    const evaluation = await admission.submit(evaluationRequest(execution.samplingIds, "admission-only-evaluation"));
    expect(getSamplings).toHaveBeenCalledWith(execution.samplingIds);
    const evaluationIds = (await store.getRun(evaluation.runId))!.evaluationIds;
    expect(evaluationIds).toHaveLength(1);
    const queued = await savedEvaluation(store, evaluationIds[0]!);
    await store.updateEvaluation({ ...queued, status: { status: "succeeded" } }, queued);
    const pipeline = await admission.submit(projectRequest("pipeline", "admission-only-pipeline"));
    expect((await store.getRun(pipeline.runId))?.phases).toEqual(["execution", "evaluation"]);
    await expect(store.getSampling(execution.samplingIds[0]!)).resolves.toBeNull();
    await expect(store.getEvaluation(evaluationIds[0]!)).resolves.toBeNull();
  });

  it("admits one independent evaluation when the same intent races or is retried", async () => {
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const execution = await runtime.submit(projectRequest("execution", "evaluation-intent-execution"));
    await waitForTerminal(runtime, execution.runId);

    const request = evaluationRequest(execution.samplingIds, "evaluation-intent");
    const [first, concurrent] = await Promise.all([
      runtime.submit(request),
      runtime.submit(request),
    ]);
    expect(concurrent).toEqual(first);
    await waitForTerminal(runtime, first.runId);

    const getProjectPlan = vi.spyOn(runtime.plans, "getProjectPlan")
      .mockRejectedValue(new Error("the plan must not be read on replay"));
    await expect(runtime.submit(request)).resolves.toEqual(first);
    expect(getProjectPlan).not.toHaveBeenCalled();
    getProjectPlan.mockRestore();
    expect(await runtime.listEvaluations(execution.samplingIds[0]!)).toHaveLength(1);
    expect(vi.mocked(harness.ensureAgent).mock.calls.filter(([input]) => input.role === "evaluator"))
      .toHaveLength(1);

    const deliberate = await runtime.submit({
      ...request,
      idempotencyKey: "new-evaluation-intent",
    });
    expect(deliberate.runId).not.toBe(first.runId);
    await waitForTerminal(runtime, deliberate.runId);
    const [current] = await runtime.listEvaluations(execution.samplingIds[0]!);
    expect((await runtime.getRun(deliberate.runId)).evaluationIds).toEqual([current!.evaluationId]);
    expect(await runtime.listEvaluations(execution.samplingIds[0]!)).toHaveLength(1);
  });

  it("shares a pending evaluation admission and rejects different facts under its key", async () => {
    const store = makeStore();
    const runtime = createAutoResumingRuntime({
      harness: makeHarness(),
      store,
      sleep: async () => undefined,
    });
    const execution = await runtime.submit(projectRequest("execution", "plan-read-execution"));
    await waitForTerminal(runtime, execution.runId);

    let enteredRead!: () => void;
    const reading = new Promise<void>((resolve) => { enteredRead = resolve; });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const getProjectPlan = runtime.plans.getProjectPlan.bind(runtime.plans);
    let gated = true;
    const readPlan = vi.spyOn(runtime.plans, "getProjectPlan").mockImplementation(async (projectId) => {
      if (gated) {
        gated = false;
        enteredRead();
        await readGate;
      }
      return getProjectPlan(projectId);
    });
    const request = evaluationRequest(execution.samplingIds, "plan-read-key");
    const firstAdmission = runtime.submit(request);
    await reading;

    const retry = runtime.submit(request);
    await expect(runtime.submit({
      idempotencyKey: request.idempotencyKey, projectId: PROJECT_ID, operation: "evaluation",
      selector: { all: true }, targets: request.targets,
    })).rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
    await expect(runtime.submit(projectRequest("execution", request.idempotencyKey)))
      .rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
    releaseRead();

    const [first, repeated] = await Promise.all([firstAdmission, retry]);
    expect(repeated).toEqual(first);
    expect(await runtime.listEvaluations(execution.samplingIds[0]!)).toHaveLength(1);
    await waitForTerminal(runtime, first.runId);

    const failedRequest = { ...request, idempotencyKey: "retry-after-plan-error" };
    readPlan.mockRejectedValueOnce(new Error("temporary plan error"));
    await expect(runtime.submit(failedRequest)).rejects.toThrow("temporary plan error");
    await expect(runtime.submit(failedRequest)).resolves.toMatchObject({ runId: expect.any(String) });
  });

  it("rejects a changed evaluation selection under an admitted key", async () => {
    const runtime = createAutoResumingRuntime({
      harness: makeHarness(),
      store: makeStore(),
      sleep: async () => undefined,
    });
    runtime.plans.samples = [makeSample("sample-1", { samplingCount: 2 })];
    runtime.plans.execution = executionPlan({ executionConcurrency: 2 });
    const execution = await runtime.submit(projectRequest("execution", "evaluation-selection-execution"));
    await waitForTerminal(runtime, execution.runId);
    const request = evaluationRequest(execution.samplingIds, "evaluation-selection");
    await runtime.submit(request);

    await expect(runtime.submit(evaluationRequest([...execution.samplingIds].reverse(), request.idempotencyKey)))
      .rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
    await expect(runtime.submit(evaluationRequest(execution.samplingIds.slice(0, 1), request.idempotencyKey)))
      .rejects.toBeInstanceOf(RuntimeRunIdentityConflictError);
    expect(await runtime.listEvaluations(execution.samplingIds[0]!)).toHaveLength(1);
  });

  it("loads a shared ProjectSample once per admission and stage", async () => {
    const harness = makeHarness();
    const plans = makePlans();
    const getSamples = vi.spyOn(plans, "getProjectSamples");
    const runtime = createAutoResumingRuntime({
      plans,
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    runtime.plans.samples = [makeSample("sample-1", { samplingCount: 2 })];
    runtime.plans.execution = executionPlan({ executionConcurrency: 2 });
    const execution = await runtime.submit(projectRequest("execution", "shared-sample-execution"));
    await waitForTerminal(runtime, execution.runId);

    runtime.plans.evaluation = evaluationPlan({ evaluationConcurrency: 2 });
    const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    await waitForTerminal(runtime, evaluation.runId);

    expect(getSamples).toHaveBeenCalledTimes(4);
    expect(getSamples.mock.calls.every(([, ids]) => equalJson(ids, ["sample-1"]))).toBe(true);
  });

  it("keeps the previous evaluation when atomic evaluation preparation fails", async () => {
    let failEvaluationRun = false;
    const store = makeStore({
      beforeRunCommit: (run) => {
        if (failEvaluationRun && run.phases[0] === "evaluation") {
          throw new Error("evaluation run preparation failed");
        }
      },
    });
    const runtime = createAutoResumingRuntime({
      harness: makeHarness(),
      store,
      sleep: async () => undefined,
    });
    const execution = await runtime.submit(projectRequest("execution", "test-request"));
    await waitForTerminal(runtime, execution.runId);

    const firstEvaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    await waitForTerminal(runtime, firstEvaluation.runId);
    const before = await runtime.getSampling(execution.samplingIds[0]!);

    failEvaluationRun = true;
    await expect(runtime.submit(evaluationRequest(execution.samplingIds)))
      .rejects.toThrow("evaluation run preparation failed");

    await expect(runtime.getSampling(execution.samplingIds[0]!)).resolves.toEqual(before);
  });

  it("reuses the same agent identity when the ensure response is lost", async () => {
    const harness = makeHarness();
    vi.mocked(harness.ensureAgent).mockRejectedValueOnce(
      new Error("connection lost after agent ensure"),
    );
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ creation: 1 }),
    });

    const run = await runtime.submit(projectRequest("execution", "test-request"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });

    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    const firstInput = vi.mocked(harness.ensureAgent).mock.calls[0]?.[0];
    const secondInput = vi.mocked(harness.ensureAgent).mock.calls[1]?.[0];
    expect(secondInput).toEqual(firstInput);
    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.subjectChatId).toBe(firstInput?.chatId);
    expect(sampling.execution.status).toBe("succeeded");
    expect(sampling.executionAttempts).toHaveLength(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("retries evaluator initial data with the same identity, runtime options and initialization key", async () => {
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ initialization: 1 }),
    });
    const execution = await runtime.submit(projectRequest("execution", "evaluator-initialization-execution"));
    await waitForTerminal(runtime, execution.runId);
    vi.mocked(harness.materializeInitialData).mockRejectedValueOnce(new Error("evaluator initialization response lost"));

    runtime.plans.evaluation = evaluationPlan({ evaluationHarness: { ...evaluationPlan().evaluationHarness, runtime: EVALUATION_RUNTIME } });
    const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    const snapshot = await waitForTerminal(runtime, evaluation.runId);
    expect(snapshot.status).toBe("succeeded");

    const inputs = vi.mocked(harness.materializeInitialData).mock.calls
      .map(([input]) => input)
      .filter((input) => input.handle.role === "evaluator");
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[0]).toMatchObject({
      runtime: EVALUATION_RUNTIME,
      idempotencyKey: `initial-data:${inputs[0]!.handle.chatId}`,
    });
    expect(inputs[0]!.data).not.toHaveProperty("initialSession");
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    expect(harness.importEvidence).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
    const record = await runtime.getEvaluation(snapshot.evaluationIds[0]!);
    expect(record.attempts).toHaveLength(1);
    expect(record.chatId).toBe(inputs[0]!.handle.chatId);
  });

  it("retries evidence import with the same key before evaluator submission", async () => {
    const harness = makeHarness();
    const committedKeys = new Set<string>();
    let copyRetryStarted!: () => void;
    const started = new Promise<void>((resolve) => { copyRetryStarted = resolve; });
    let finishCopy!: () => void;
    const pending = new Promise<void>((resolve) => { finishCopy = resolve; });
    vi.mocked(harness.importEvidence).mockImplementation(async ({ idempotencyKey }) => {
      if (!committedKeys.has(idempotencyKey)) {
        committedKeys.add(idempotencyKey);
        throw new Error("evidence import response lost after commit");
      }
      copyRetryStarted();
      await pending;
    });
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ initialization: 1 }),
    });

    const run = await runtime.submit(projectRequest("pipeline", "evidence-copy-response-lost"));
    await started;
    const evaluatorSubmissions = () => vi.mocked(harness.submitAgent).mock.calls
      .filter(([input]) => input.handle.role === "evaluator");
    expect(evaluatorSubmissions()).toHaveLength(0);
    expect(harness.collectEvaluation).not.toHaveBeenCalled();
    await expect(runtime.getRun(run.runId)).resolves.toMatchObject({ phase: "evaluation", status: "retrying" });
    finishCopy();
    const snapshot = await waitForTerminal(runtime, run.runId);
    expect(snapshot.status).toBe("succeeded");

    expect(committedKeys.size).toBe(1);
    const [first, second] = vi.mocked(harness.importEvidence).mock.calls;
    expect(second![0].idempotencyKey).toBe(first![0].idempotencyKey);
    expect(second![0].evidence.ref).toEqual(first![0].evidence.ref);
    expect(first![0].idempotencyKey)
      .toBe(`evidence:${first![0].evidence.ref.evidenceId}:${snapshot.evaluationIds[0]}`);
    expect(first![0]).toMatchObject({ root: "/evidence", handle: { role: "evaluator" } });
    const inputs = vi.mocked(harness.materializeInitialData).mock.calls
      .map(([input]) => input)
      .filter((input) => input.handle.role === "evaluator");
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[0]!.idempotencyKey).not.toBe(first![0].idempotencyKey);
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    expect(evaluatorSubmissions()).toHaveLength(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
    const record = await runtime.getEvaluation(snapshot.evaluationIds[0]!);
    expect(record.attempts).toHaveLength(1);
  });

  it.each([true, false])(
    "does not submit or restart the evaluator after evidence initialization fails (retryable: %s)",
    async (retryable) => {
      const harness = makeHarness();
      vi.mocked(harness.importEvidence).mockRejectedValue(Object.assign(
        new Error("evidence initialization failed"),
        { retryable },
      ));
      const decide = vi.fn<RetryController["decide"]>()
        .mockResolvedValueOnce({ shouldRetry: true, backoffMs: 0 })
        .mockResolvedValue({ shouldRetry: false });
      const sleep = vi.fn(async (_milliseconds: number) => undefined);
      const runtime = createAutoResumingRuntime({
        harness,
        store: makeStore(),
        sleep,
        createRetryController: () => ({ decide }),
      });
      const execution = await runtime.submit(projectRequest("execution", `evidence-failure-execution-${retryable}`));
      await waitForTerminal(runtime, execution.runId);

      runtime.plans.evaluation = evaluationPlan({ retryPolicy: RETRY_ONE });
      const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
      const snapshot = await waitForTerminal(runtime, evaluation.runId);
      expect(snapshot.status).toBe("failed");

      expect(harness.importEvidence).toHaveBeenCalledTimes(retryable ? 2 : 1);
      expect(decide.mock.calls.map(([input]) => input)).toEqual(retryable ? [
        { operation: "initialization", failureKind: "network", attemptNumber: 1, error: expect.any(String) },
        { operation: "initialization", failureKind: "network", attemptNumber: 2, error: expect.any(String) },
      ] : []);
      expect(sleep).toHaveBeenCalledTimes(retryable ? 1 : 0);
      expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
      expect(harness.submitAgent).toHaveBeenCalledTimes(1);
      expect(harness.restartAgent).not.toHaveBeenCalled();
      expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
      expect(harness.collectEvaluation).not.toHaveBeenCalled();
      const record = await runtime.getEvaluation(snapshot.evaluationIds[0]!);
      expect(record.status).toEqual({ status: "failed", lastError: "evidence initialization failed" });
      expect(record.attempts).toHaveLength(1);
      await expect(runtime.getSampling(execution.samplingIds[0]!)).resolves.toMatchObject({
        execution: { status: "succeeded" },
      });
    },
  );

  it("freezes a succeeded Subject's evidence and points its trajectory into the bundle", async () => {
    const harness = makeHarness();
    const store = makeStore();
    const runtime = createAutoResumingRuntime({ harness, store, sleep: async () => undefined });
    const run = await runtime.submit(projectRequest("execution", "evidence-freeze"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

    const sampling = await saved(store, run.samplingIds[0]!);
    const evidence = sampling.evidence!;
    expect(harness.exportEvidence).toHaveBeenCalledWith(expect.objectContaining({
      handle: expect.objectContaining({ role: "subject", chatId: sampling.subjectChatId }),
      limits: DEFAULT_EVIDENCE_LIMITS,
    }));
    const { manifest } = await TEST_EVIDENCE.open(evidence);
    expect(manifest.source).toMatchObject({ samplingId: sampling.samplingId, agentRef: { chatId: sampling.subjectChatId } });
    expect(sampling.trajectory).toEqual({
      trajectoryId: evidence.evidenceId,
      source: "subject",
      path: `evidence:${evidence.evidenceId}/trajectory/`,
      contentHash: `sha256:${evidence.manifestSha256}`,
    });
  });

  it("fails the execution, keeping its output, when evidence export never succeeds", async () => {
    const harness = makeHarness();
    vi.mocked(harness.exportEvidence).mockRejectedValue(Object.assign(new Error("export unavailable"), { retryable: false }));
    const store = makeStore();
    const runtime = createAutoResumingRuntime({ harness, store, sleep: async () => undefined });
    const run = await runtime.submit(projectRequest("pipeline", "evidence-export-fails"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    const sampling = await saved(store, run.samplingIds[0]!);
    expect(sampling.execution).toMatchObject({ status: "failed", lastError: expect.stringContaining("export unavailable") });
    expect(sampling.artifacts).toEqual([{ artifactId: "artifact-1", kind: "project", path: "/eval/output" }]);
    expect(sampling).not.toHaveProperty("evidence");
    expect(harness.submitAgent).toHaveBeenCalledTimes(1);
    expect(harness.importEvidence).not.toHaveBeenCalled();
  });

  it("fails an Evaluation whose Sampling has no evidence bundle without starting an Evaluator", async () => {
    const harness = makeHarness();
    const store = makeStore();
    const runtime = createAutoResumingRuntime({ harness, store, sleep: async () => undefined });
    const execution = await runtime.submit(projectRequest("execution", "no-evidence-execution"));
    await waitForTerminal(runtime, execution.runId);
    const stored = await saved(store, execution.samplingIds[0]!);
    const { evidence: _evidence, ...withoutEvidence } = stored;
    await store.updateSampling(withoutEvidence, stored);

    const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    const snapshot = await waitForTerminal(runtime, evaluation.runId);
    expect(snapshot.status).toBe("failed");
    await expect(runtime.getEvaluation(snapshot.evaluationIds[0]!)).resolves.toMatchObject({
      status: { status: "failed", lastError: "sampling has no evidence bundle" },
    });
    expect(vi.mocked(harness.ensureAgent).mock.calls.filter(([input]) => input.role === "evaluator")).toHaveLength(0);
  });

  it("keeps execution success when evaluation fails", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectEvaluation).mockResolvedValue({
      status: "failed",
      artifacts: [],
      trajectory: {
        trajectoryId: "trajectory-2",
        source: "evaluator",
        path: "/eval/evaluation.jsonl",
      },
      error: "evaluation output failed",
    });
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const execution = await runtime.submit(projectRequest("execution", "test-request"));
    await waitForTerminal(runtime, execution.runId);

    const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    const evaluationSnapshot = await waitForTerminal(runtime, evaluation.runId);
    await expect(evaluationSnapshot).toMatchObject({
      status: "failed",
    });
    await expect(runtime.getEvaluation(evaluationSnapshot.evaluationIds[0]!)).resolves.toMatchObject({
      status: {
        status: "failed",
        lastError: "evaluation output collection failed: evaluation output failed",
      },
    });

    await expect(runtime.getSampling(execution.samplingIds[0]!)).resolves.toMatchObject({
      execution: { status: "succeeded" },
    });
    await expect(runtime.getSampling(execution.samplingIds[0]!)).resolves.not.toHaveProperty("sample");
  });

  it("records the Evaluator score and syncs it to the Subject session", async () => {
    const harness = makeHarness();
    const publish = vi.fn(async () => undefined);
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      scores: { read: () => ({ score: 0.9 }), publish },
    });
    const execution = await runtime.submit(projectRequest("execution", "test-request"));
    await waitForTerminal(runtime, execution.runId);
    const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    const snapshot = await waitForTerminal(runtime, evaluation.runId);

    const sampling = await runtime.getSampling(execution.samplingIds[0]!);
    const record = await runtime.getEvaluation(snapshot.evaluationIds[0]!);
    expect(record).toMatchObject({
      status: { status: "succeeded" },
      output: { structuredOutput: { content: '{"score":0.9}' } },
      scoreSync: { status: "synced" },
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      evaluationId: record!.evaluationId,
      subjectChatId: sampling!.subjectChatId,
      evaluatorChatId: record!.chatId,
      score: 0.9,
    }));
  });

  it("keeps a succeeded Evaluation when its score cannot be synced", async () => {
    const onError = vi.fn();
    const runtime = createAutoResumingRuntime({
      harness: makeHarness(),
      store: makeStore(),
      sleep: async () => undefined,
      onError,
      scores: { read: () => ({ score: 0.9 }), publish: async () => { throw new Error("Langfuse unavailable"); } },
    });
    const execution = await runtime.submit(projectRequest("execution", "test-request"));
    await waitForTerminal(runtime, execution.runId);
    const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    const snapshot = await waitForTerminal(runtime, evaluation.runId);

    await expect(runtime.getEvaluation(snapshot.evaluationIds[0]!)).resolves.toMatchObject({
      status: { status: "succeeded" },
      output: { structuredOutput: { content: '{"score":0.9}' } },
      scoreSync: { status: "failed", lastError: "Langfuse unavailable" },
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("score was not synced"),
    }), expect.objectContaining({ stage: "evaluation", evaluationId: expect.any(String) }));
  });

  it("keeps an Evaluation whose result breaks the output schema but syncs no score", async () => {
    const publish = vi.fn(async () => undefined);
    const runtime = createAutoResumingRuntime({
      harness: makeHarness(),
      store: makeStore(),
      sleep: async () => undefined,
      scores: { read: () => undefined, publish },
    });
    const execution = await runtime.submit(projectRequest("execution", "test-request"));
    await waitForTerminal(runtime, execution.runId);
    const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    const snapshot = await waitForTerminal(runtime, evaluation.runId);

    const record = await runtime.getEvaluation(snapshot.evaluationIds[0]!);
    expect(record).toMatchObject({ status: { status: "succeeded" }, output: { structuredOutput: { content: '{"score":0.9}' } } });
    expect(record?.output).not.toHaveProperty("score");
    expect(record).not.toHaveProperty("scoreSync");
    expect(publish).not.toHaveBeenCalled();
  });

  it("retries evaluation output collection without restarting the evaluator", async () => {
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ collection: 1 }),
    });
    const execution = await runtime.submit(projectRequest("execution", "test-request"));
    await waitForTerminal(runtime, execution.runId);

    vi.mocked(harness.collectEvaluation)
      .mockRejectedValueOnce(new Error("temporary evaluation artifact fetch failure"));
    const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));

    await expect(waitForTerminal(runtime, evaluation.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(2);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("persists run and sampling records for another runtime instance", async () => {
    const harness = makeHarness();
    const store = makeStore();
    const runtime = createAutoResumingRuntime({
      harness,
      store,
      sleep: async () => undefined,
    });

    const run = await runtime.submit(projectRequest("execution", "test-request"));
    await waitForTerminal(runtime, run.runId);

    const restoredRuntime = createAutoResumingRuntime({
      harness,
      store,
      sleep: async () => undefined,
    });
    await expect(restoredRuntime.getRun(run.runId)).resolves.toMatchObject({
      runId: run.runId,
      phase: "execution",
      status: "succeeded",
    });
    await expect(restoredRuntime.getSampling(run.samplingIds[0]!)).resolves.toMatchObject({
      execution: { status: "succeeded" },
      subjectChatId: expect.any(String),
    });
    await expect(restoredRuntime.getSampling(run.samplingIds[0]!)).resolves.not.toHaveProperty("sample");
  });

  it("restarts an evaluator submission without creating another evaluator agent", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValueOnce(makeSubmission()).mockResolvedValueOnce({
      submissionId: "submission-1",
      status: "failed",
      retryable: true,
      error: "temporary evaluator failure",
    });
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    const execution = await runtime.submit(projectRequest("execution", "test-request"));
    await waitForTerminal(runtime, execution.runId);

    runtime.plans.evaluation = evaluationPlan({ retryPolicy: RETRY_ONE });
    const evaluation = await runtime.submit(evaluationRequest(execution.samplingIds));
    const snapshot = await waitForTerminal(runtime, evaluation.runId);
    expect(snapshot.status).toBe("succeeded");
    const evaluator = await runtime.getEvaluation(snapshot.evaluationIds[0]!);
    const submissionIds = evaluator.attempts.map((attempt) => attempt.submissionId);
    expect(submissionIds).toHaveLength(2);
    expect(submissionIds[0]).toBe("submission-1");
    expect(submissionIds[1]).toBeDefined();
    expect(submissionIds[1]).not.toBe(submissionIds[0]);
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    expect(harness.restartAgent).toHaveBeenCalledTimes(1);
  });

  it("automatically restarts a retryable submission without creating a new sampling", async () => {
    const harness = makeHarness();
    const submitAgent = vi.mocked(harness.submitAgent);
    submitAgent
      .mockResolvedValueOnce({
        submissionId: "submission-1",
        status: "failed",
        retryable: true,
        error: "temporary upstream failure",
      })
      .mockResolvedValueOnce(makeSubmission());
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await runtime.submit(projectRequest("execution", "test-request"));
    const snapshot = await waitForTerminal(runtime, run.runId);

    expect(snapshot.status).toBe("succeeded");
    expect(run.samplingIds).toHaveLength(1);
    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    const submissionIds = sampling.executionAttempts.map((attempt) => attempt.submissionId);
    expect(submissionIds).toHaveLength(2);
    expect(submissionIds[0]).toBe("submission-1");
    expect(submissionIds[1]).toBeDefined();
    expect(submissionIds[1]).not.toBe(submissionIds[0]);
    expect(harness.restartAgent).toHaveBeenCalledTimes(1);
  });

  it("reuses the restart idempotency key when the restart response is lost", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValueOnce({
      submissionId: "submission-1",
      status: "failed",
      retryable: true,
      error: "temporary upstream failure",
    });
    vi.mocked(harness.restartAgent)
      .mockRejectedValueOnce(new Error("connection lost after restart"))
      .mockResolvedValueOnce(makeSubmission("completed", "submission-2"));
    vi.mocked(harness.inspectAgentOperation).mockResolvedValueOnce(null);
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: createProductionRetryController,
    });

    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await runtime.submit(projectRequest("execution", "test-request"));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.restartAgent).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(harness.restartAgent).mock.calls[0]?.[0];
    const secondCall = vi.mocked(harness.restartAgent).mock.calls[1]?.[0];
    expect(firstCall?.idempotencyKey).toBe(secondCall?.idempotencyKey);
    expect(harness.inspectAgentOperation).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: firstCall?.idempotencyKey,
    }));
    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts.map((attempt) => attempt.submissionId))
      .toEqual(["submission-1", "submission-2"]);
  });

  it("does not let the Agent restart budget cut off transient restart RPC retries", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValueOnce({
      submissionId: "submission-1",
      status: "failed",
      retryable: true,
      error: "temporary upstream failure",
    });
    vi.mocked(harness.restartAgent)
      .mockRejectedValueOnce(Object.assign(new Error("restart transport 1"), { retryable: true }))
      .mockRejectedValueOnce(Object.assign(new Error("restart transport 2"), { retryable: true }))
      .mockResolvedValueOnce(makeSubmission("completed", "submission-2"));
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: createProductionRetryController,
    });

    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await runtime.submit(projectRequest("execution", "restart-rpc-transient-retries"));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });
    expect(harness.restartAgent).toHaveBeenCalledTimes(3);
    expect((await runtime.getSampling(run.samplingIds[0]!)).executionAttempts).toHaveLength(2);
  });

  it("creates a new restart key only after the previous key is confirmed failed", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValueOnce({
      submissionId: "submission-1",
      status: "failed",
      retryable: true,
      error: "temporary upstream failure",
    });
    vi.mocked(harness.restartAgent)
      .mockRejectedValueOnce(new Error("connection lost after restart"))
      .mockResolvedValueOnce(makeSubmission("completed", "submission-3"));
    vi.mocked(harness.inspectAgentOperation).mockResolvedValueOnce({
      submissionId: "submission-2",
      status: "failed",
      retryable: true,
      error: "restart was rejected by the agent",
    });
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: createProductionRetryController,
    });

    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_TWO });
    const run = await runtime.submit(projectRequest("execution", "test-request"));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.restartAgent).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(harness.restartAgent).mock.calls[0]?.[0];
    const secondCall = vi.mocked(harness.restartAgent).mock.calls[1]?.[0];
    expect(firstCall?.idempotencyKey).not.toBe(secondCall?.idempotencyKey);
    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts.map((attempt) => attempt.submissionId))
      .toEqual(["submission-1", "submission-2", "submission-3"]);
  });

  it("reconciles an uncertain submission before retrying", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockRejectedValueOnce(new Error("connection lost after submit"));
    vi.mocked(harness.inspectAgentOperation)
      .mockResolvedValueOnce(makeSubmission("completed", "submission-1"));
    vi.mocked(harness.collectExecution)
      .mockRejectedValueOnce(new Error("temporary artifact fetch failure"));
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ collection: 1 }),
    });

    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await runtime.submit(projectRequest("execution", "test-request"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(harness.submitAgent).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.inspectAgentOperation).toHaveBeenCalledTimes(1);
    expect((await runtime.getSampling(run.samplingIds[0]!)).executionAttempts[0]!.submissionId)
      .toBe("submission-1");
    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
  });

  it("chains execution and evaluation with separate harness stages", async () => {
    const harness = makeHarness();
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    const run = await runtime.submit(projectRequest("pipeline", "test-request"));
    await expect(runtime.getRun(run.runId)).resolves.toMatchObject({ status: "queued" });
    const snapshot = await waitForTerminal(runtime, run.runId);

    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.phases).toEqual(["execution", "evaluation"]);
    expect(snapshot.phase).toBe("evaluation");
    expect(harness.ensureAgent).toHaveBeenCalledTimes(2);
    expect(harness.collectExecution).toHaveBeenCalledTimes(1);
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(1);
  });

  it("starts each evaluation while another Sampling is still executing", async () => {
    const harness = makeHarness();
    let markExecutionBStarted!: () => void;
    const executionBStarted = new Promise<void>((resolve) => {
      markExecutionBStarted = resolve;
    });
    let releaseExecutionB!: () => void;
    const executionBGate = new Promise<void>((resolve) => {
      releaseExecutionB = resolve;
    });
    let secondSamplingId!: string;
    vi.mocked(harness.collectExecution).mockImplementation(async ({ handle }) => {
      if (handle.samplingId === secondSamplingId) {
        markExecutionBStarted();
        await executionBGate;
      }
      return {
        samplingId: handle.samplingId,
        status: "succeeded",
        artifacts: [{ artifactId: `artifact-${handle.samplingId}`, kind: "project", path: "/output" }],
        trajectory: { trajectoryId: `trajectory-${handle.samplingId}`, source: "subject", path: "/trajectory" },
      };
    });
    let markEvaluationAStarted!: () => void;
    const evaluationAStarted = new Promise<void>((resolve) => {
      markEvaluationAStarted = resolve;
    });
    let releaseEvaluationA!: () => void;
    const evaluationAGate = new Promise<void>((resolve) => {
      releaseEvaluationA = resolve;
    });
    let firstSamplingId!: string;
    vi.mocked(harness.collectEvaluation).mockImplementation(async ({ handle }) => {
      if (handle.samplingId === firstSamplingId) {
        markEvaluationAStarted();
        await evaluationAGate;
      }
      return {
        status: "succeeded",
        artifacts: [{ artifactId: `evaluation-artifact-${handle.samplingId}`, kind: "evaluation", path: "/eval/result" }],
        structuredOutput: { path: "/output/result.json", content: '{"score":0.9}' },
        trajectory: { trajectoryId: `evaluation-trajectory-${handle.samplingId}`, source: "evaluator", path: "/eval/evaluation.jsonl" },
      };
    });

    const runtime = createAutoResumingRuntime({
      plans: makePlans([makeSample("sample-1"), makeSample("sample-2")]),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });
    runtime.plans.execution = executionPlan({ executionConcurrency: 2 });
    runtime.plans.evaluation = evaluationPlan({ evaluationConcurrency: 1 });
    const run = await runtime.submit(projectRequest("pipeline", "per-sampling-pipeline", ["sample-1", "sample-2"]));
    firstSamplingId = run.samplingIds[0]!;
    secondSamplingId = run.samplingIds[1]!;

    await executionBStarted;
    await evaluationAStarted;
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(1);
    expect((await runtime.getSampling(run.samplingIds[1]!)).execution.status).toBe("running");

    releaseExecutionB();
    releaseEvaluationA();
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });
    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(2);
  });

  it("evaluates successful pipeline samplings when another execution fails", async () => {
    const harness = makeHarness();
    let subjectSubmissionCount = 0;
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => {
      if (handle.role === "subject" && subjectSubmissionCount++ === 0) {
        return {
          submissionId: "submission-1",
          status: "failed",
          retryable: false,
          error: "subject execution failed",
        };
      }
      return makeSubmission();
    });

    let releaseEvaluation!: () => void;
    let markEvaluationStarted!: () => void;
    const evaluationStarted = new Promise<void>((resolve) => {
      markEvaluationStarted = resolve;
    });
    const evaluationGate = new Promise<void>((resolve) => {
      releaseEvaluation = resolve;
    });
    vi.mocked(harness.collectEvaluation).mockImplementation(async () => {
      markEvaluationStarted();
      await evaluationGate;
      return {
        status: "succeeded",
        artifacts: [{ artifactId: "evaluation-artifact-1", kind: "evaluation", path: "/eval/result" }],
        structuredOutput: { path: "/output/result.json", content: '{"score":0.9}' },
        trajectory: {
          trajectoryId: "trajectory-2",
          source: "evaluator",
          path: "/eval/evaluation.jsonl",
        },
      };
    });

    const runtime = createAutoResumingRuntime({
      plans: makePlans([
        makeSample("sample-1"),
        makeSample("sample-2"),
        makeSample("sample-3"),
      ]),
      harness,
      store: makeStore(),
      sleep: async () => undefined,
    });

    runtime.plans.execution = executionPlan({ executionConcurrency: 3 });
    runtime.plans.evaluation = evaluationPlan({ evaluationConcurrency: 2 });
    const run = await runtime.submit(projectRequest("pipeline", "test-request", ["sample-1", "sample-2", "sample-3"]));

    await evaluationStarted;
    await expect(runtime.getRun(run.runId)).resolves.toMatchObject({ status: "running" });
    releaseEvaluation();

    const snapshot = await waitForTerminal(runtime, run.runId);
    expect(snapshot).toMatchObject({
      status: "failed",
    });
    const records = await Promise.all(
      run.samplingIds.map((samplingId) => runtime.getSampling(samplingId)),
    );
    const failedExecutionRecords = records.filter(
      (sampling) => sampling.execution.status === "failed",
    );
    const successfulExecutionRecords = records.filter(
      (sampling) => sampling.execution.status === "succeeded",
    );
    const evaluations = await Promise.all(
      snapshot.evaluationIds.map((evaluationId) => runtime.getEvaluation(evaluationId)),
    );
    const evaluationBySamplingId = new Map(
      evaluations.map((evaluation) => [evaluation.samplingId, evaluation]),
    );

    expect(failedExecutionRecords).toHaveLength(1);
    expect(successfulExecutionRecords).toHaveLength(2);
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(2);
    expect(evaluationBySamplingId.get(failedExecutionRecords[0]!.samplingId)?.status)
      .toEqual({ status: "cancelled", lastError: "execution did not succeed" });
    expect(successfulExecutionRecords.every(
      (sampling) => evaluationBySamplingId.get(sampling.samplingId)?.status.status === "succeeded",
    )).toBe(true);
  });
});

describe("Project Run targets and partial replacement", () => {
  const DATASETS: readonly ProjectDatasetSnapshot[] = [
    { datasetId: "dataset-a", name: "A", kind: "general", projectSampleIds: ["sample-1", "sample-2"] },
    { datasetId: "dataset-b", name: "B", kind: "prompt", projectSampleIds: ["sample-2", "sample-3"] },
  ];

  function projectPlans(options: { readonly evaluation?: null } = {}) {
    return makePlans([
      makeSample("sample-1", { datasetIds: ["dataset-a"] }),
      makeSample("sample-2", { datasetIds: ["dataset-a", "dataset-b"], samplingCount: 2 }),
      makeSample("sample-3", { datasetIds: ["dataset-b"] }),
    ], { datasets: DATASETS, ...options });
  }

  type TestRuntime = ReturnType<typeof createRuntime>;

  async function run(
    runtime: TestRuntime,
    idempotencyKey: string,
    operation: RunOperation,
    selector: RunTargetSelector,
  ) {
    const preview = await runtime.preview({ projectId: PROJECT_ID, operation, selector });
    const handle = await runtime.submit({ idempotencyKey, projectId: PROJECT_ID, operation, selector, targets: preview.targets });
    await waitForTerminal(runtime, handle.runId);
    return { handle, preview };
  }

  async function currentResults(store: TestStore) {
    const samplings = await store.listProjectSamplings(PROJECT_ID, ["sample-1", "sample-2", "sample-3"]);
    const evaluations = await Promise.all(samplings.map(({ samplingId }) => store.listEvaluations(samplingId)));
    return { samplings, evaluations: evaluations.flat() };
  }

  it("expands Datasets, ProjectSamples and Samplings inside the snapshot with stable deduplication", async () => {
    const store = makeStore({ plans: projectPlans() });
    const runtime = createAutoResumingRuntime({ harness: makeHarness(), store, sleep: async () => undefined });
    const plan = (await store.plans().getProjectPlan(PROJECT_ID))!;

    await expect(runtime.preview({ projectId: PROJECT_ID, operation: "execution", selector: { all: true } })).resolves.toEqual({
      projectId: PROJECT_ID, operation: "execution", selector: { all: true },
      targets: { projectSampleIds: ["sample-1", "sample-2", "sample-3"], samplingIds: [] },
      replacedSamplingCount: 0, newSamplingCount: 4, evaluationCount: 0,
      executionPlanDigest: plan.executionPlanDigest, evaluationPlanDigest: null,
    });
    await expect(runtime.preview({
      projectId: PROJECT_ID, operation: "pipeline", selector: { datasetIds: ["dataset-b", "dataset-a"], projectSampleIds: ["sample-2"] },
    })).resolves.toMatchObject({
      targets: { projectSampleIds: ["sample-2", "sample-3", "sample-1"], samplingIds: [] },
      newSamplingCount: 4, evaluationCount: 4, evaluationPlanDigest: plan.evaluation!.digest,
    });

    const { handle: first } = await run(runtime, "first-pipeline", "pipeline", { all: true });
    expect(first.samplingIds).toHaveLength(4);
    const [s1, s2a, s2b, s3] = (await currentResults(store)).samplings;
    expect([s1, s2a, s2b, s3].map((sampling) => sampling!.projectSampleId)).toEqual(["sample-1", "sample-2", "sample-2", "sample-3"]);

    await expect(runtime.preview({
      projectId: PROJECT_ID, operation: "execution",
      selector: { projectSampleIds: ["sample-3"], samplingIds: [s3!.samplingId, s1!.samplingId, s2b!.samplingId] },
    })).resolves.toMatchObject({
      targets: { projectSampleIds: ["sample-3"], samplingIds: [s1!.samplingId, s2b!.samplingId] },
      replacedSamplingCount: 3, newSamplingCount: 3, evaluationCount: 0,
    });
    await expect(runtime.preview({
      projectId: PROJECT_ID, operation: "evaluation", selector: { datasetIds: ["dataset-a"], samplingIds: [s3!.samplingId, s1!.samplingId] },
    })).resolves.toMatchObject({
      targets: { projectSampleIds: [], samplingIds: [s1!.samplingId, s2a!.samplingId, s2b!.samplingId, s3!.samplingId] },
      replacedSamplingCount: 0, newSamplingCount: 0, evaluationCount: 4,
    });

    await seedSampling(store, { ...s2a!, execution: { status: "failed", lastError: "subject failed" } });
    await expect(runtime.preview({ projectId: PROJECT_ID, operation: "evaluation", selector: { datasetIds: ["dataset-b"] } }))
      .resolves.toMatchObject({ targets: { projectSampleIds: [], samplingIds: [s2b!.samplingId, s3!.samplingId] } });
    await expect(runtime.preview({ projectId: PROJECT_ID, operation: "evaluation", selector: { samplingIds: [s2a!.samplingId] } }))
      .rejects.toMatchObject({ reason: "sampling-unavailable" });
  });

  it("re-runs selected Samplings and ProjectSamples while unselected results stay untouched", async () => {
    const store = makeStore({ plans: projectPlans() });
    const runtime = createAutoResumingRuntime({ harness: makeHarness(), store, sleep: async () => undefined });
    await run(runtime, "first-pipeline", "pipeline", { all: true });
    const before = await currentResults(store);
    const [s1, s2a, s2b, s3] = before.samplings;

    const { handle: rerun } = await run(runtime, "rerun-one-sampling", "execution", { samplingIds: [s2a!.samplingId] });
    expect(rerun.samplingIds).toHaveLength(1);
    await expect(store.getSampling(s2a!.samplingId)).resolves.toBeNull();
    await expect(store.listEvaluations(s2a!.samplingId)).resolves.toEqual([]);
    const replacement = await saved(store, rerun.samplingIds[0]!);
    expect(replacement).toMatchObject({ projectSampleId: "sample-2", execution: { status: "succeeded" } });
    await expect(store.listEvaluations(replacement.samplingId)).resolves.toEqual([]);
    for (const kept of [s1, s2b, s3]) {
      await expect(store.getSampling(kept!.samplingId)).resolves.toEqual(kept);
      await expect(store.listEvaluations(kept!.samplingId)).resolves.toEqual(
        before.evaluations.filter((evaluation) => evaluation.samplingId === kept!.samplingId),
      );
    }

    const { handle: pipeline, preview } = await run(runtime, "rerun-sample-3", "pipeline", { datasetIds: ["dataset-b"], samplingIds: [s1!.samplingId] });
    expect(preview).toMatchObject({
      targets: { projectSampleIds: ["sample-2", "sample-3"], samplingIds: [s1!.samplingId] },
      replacedSamplingCount: 4, newSamplingCount: 4, evaluationCount: 4,
    });
    const after = await currentResults(store);
    expect(after.samplings.map(({ samplingId }) => samplingId).sort()).toEqual([...pipeline.samplingIds].sort());
    expect(after.evaluations).toHaveLength(4);
    expect(after.evaluations.every(({ status }) => status.status === "succeeded")).toBe(true);
  });

  it("re-evaluates selected Samplings without changing any Subject fact", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const store = makeStore({ plans: projectPlans() });
    const runtime = createAutoResumingRuntime({ harness, store, sleep: async () => undefined });
    await run(runtime, "first-pipeline", "pipeline", { all: true });
    const before = await currentResults(store);
    const [s1, s2a] = before.samplings;
    const subjectCalls = vi.mocked(harness.submitAgent).mock.calls.filter(([input]) => input.handle.role === "subject").length;

    const { handle } = await run(runtime, "re-evaluate", "evaluation", { samplingIds: [s2a!.samplingId] });

    expect(handle.samplingIds).toEqual([s2a!.samplingId]);
    const after = await currentResults(store);
    expect(after.samplings).toEqual(before.samplings);
    const [replaced] = await store.listEvaluations(s2a!.samplingId);
    expect(replaced!.evaluationId).not.toBe(before.evaluations.find(({ samplingId }) => samplingId === s2a!.samplingId)!.evaluationId);
    expect(replaced!.status).toEqual({ status: "succeeded" });
    expect(after.evaluations.filter(({ samplingId }) => samplingId !== s2a!.samplingId))
      .toEqual(before.evaluations.filter(({ samplingId }) => samplingId !== s2a!.samplingId));
    await expect(store.listEvaluations(s1!.samplingId)).resolves.toEqual(
      before.evaluations.filter(({ samplingId }) => samplingId === s1!.samplingId),
    );
    expect(vi.mocked(harness.submitAgent).mock.calls.filter(([input]) => input.handle.role === "subject")).toHaveLength(subjectCalls);
  });

  it("rejects evaluation-only on a new Project and evaluating Runs without an evaluation plan", async () => {
    const store = makeStore({ plans: projectPlans({ evaluation: null }) });
    const runtime = createAutoResumingRuntime({ harness: makeHarness(), store, sleep: async () => undefined });
    for (const operation of ["pipeline", "evaluation"] as const) {
      await expect(runtime.preview({ projectId: PROJECT_ID, operation, selector: { all: true } }))
        .rejects.toMatchObject({ name: "RuntimeAdmissionConflictError", reason: "evaluation-plan-required" });
      await expect(runtime.submit({
        idempotencyKey: `${operation}-without-plan`, projectId: PROJECT_ID, operation, selector: { all: true },
        targets: operation === "pipeline" ? { projectSampleIds: ["sample-1"], samplingIds: [] } : { projectSampleIds: [], samplingIds: [] },
      })).rejects.toMatchObject({ reason: "evaluation-plan-required" });
    }
    const { handle } = await run(runtime, "execution-only", "execution", { all: true });
    expect(handle.samplingIds).toHaveLength(4);
    expect((await store.plans().getProjectPlan(PROJECT_ID))?.evaluation).toBeNull();

    const fresh = createAutoResumingRuntime({ harness: makeHarness(), store: makeStore({ plans: projectPlans() }) });
    await expect(fresh.preview({ projectId: PROJECT_ID, operation: "evaluation", selector: { all: true } }))
      .rejects.toMatchObject({ reason: "empty-targets" });
    await expect(fresh.submit({
      idempotencyKey: "new-project-evaluation", projectId: PROJECT_ID, operation: "evaluation",
      selector: { all: true }, targets: { projectSampleIds: [], samplingIds: [] },
    })).rejects.toMatchObject({ reason: "empty-targets" });
  });

  it("locks the evaluation plan when the first evaluating Run is admitted", async () => {
    const store = makeStore({ plans: projectPlans() });
    const admission = createTestAdmission(store);
    const handle = await admission.submit({
      idempotencyKey: "first-execution", projectId: PROJECT_ID, operation: "execution",
      selector: { projectSampleIds: ["sample-1"] }, targets: { projectSampleIds: ["sample-1"], samplingIds: [] },
    });
    expect((await store.plans().getProjectPlan(PROJECT_ID))?.evaluation?.lockedAt).toBeNull();
    const queued = await saved(store, handle.samplingIds[0]!);
    await store.updateSampling({ ...queued, execution: { status: "succeeded" } }, queued);
    await admission.submit({
      idempotencyKey: "first-evaluation", projectId: PROJECT_ID, operation: "evaluation",
      selector: { samplingIds: handle.samplingIds }, targets: { projectSampleIds: [], samplingIds: [...handle.samplingIds] },
    });
    expect((await store.plans().getProjectPlan(PROJECT_ID))?.evaluation?.lockedAt).toEqual(expect.any(String));
  });

  it("rejects a new key while the Project has an unfinished Run and targets that changed before the transaction", async () => {
    const store = makeStore({ plans: projectPlans() });
    const admission = createTestAdmission(store);
    const request = {
      idempotencyKey: "first", projectId: PROJECT_ID, operation: "execution" as const,
      selector: { projectSampleIds: ["sample-1"] }, targets: { projectSampleIds: ["sample-1"], samplingIds: [] },
    };
    const first = await admission.submit(request);
    await expect(admission.submit({ ...request, idempotencyKey: "second" })).rejects.toBeInstanceOf(RuntimeProjectBusyError);
    await expect(admission.submit(request)).resolves.toEqual(first);

    const queued = await saved(store, first.samplingIds[0]!);
    await store.updateSampling({ ...queued, execution: { status: "succeeded" } }, queued);
    vi.spyOn(store, "listProjectSamplings").mockResolvedValueOnce([]);
    await expect(admission.submit({ ...request, idempotencyKey: "stale" }))
      .rejects.toMatchObject({ name: "RuntimeAdmissionConflictError", reason: "stale-targets" });
    await expect(store.getSampling(first.samplingIds[0]!)).resolves.toMatchObject({ execution: { status: "succeeded" } });

    const replaced = await admission.submit({ ...request, idempotencyKey: "replace" });
    const done = await saved(store, replaced.samplingIds[0]!);
    await store.updateSampling({ ...done, execution: { status: "succeeded" } }, done);
    await expect(admission.submit({
      ...request, idempotencyKey: "replaced-target", selector: { samplingIds: first.samplingIds },
      targets: { projectSampleIds: [], samplingIds: [...first.samplingIds] },
    })).rejects.toMatchObject({ name: "RuntimeEntityNotFoundError", entity: "sampling" });
    await expect(admission.submit({
      ...request, idempotencyKey: "overlap", selector: { all: true },
      targets: { projectSampleIds: ["sample-1"], samplingIds: [...replaced.samplingIds] },
    })).rejects.toMatchObject({ name: "RuntimeInputError", field: "targets.samplingIds" });
  });

  it.each(["execution", "evaluation"] as const)("never resumes a Run whose %s plan digest changed", async (stage) => {
    const store = makeStore({ plans: projectPlans() });
    const harness = makeHarness();
    const handle = await createTestAdmission(store).submit(projectRequest("pipeline", `changed-${stage}`));
    if (stage === "execution") store.plans().execution = executionPlan({ retryPolicy: RETRY_ONE });
    else store.plans().evaluation = evaluationPlan({ evaluationConcurrency: 2 });
    const resumer = createTestResumer(store, harness);

    await expect(resumer.resume(handle.runId)).rejects.toThrow("was admitted against a different plan");
    expect(harness.ensureAgent).not.toHaveBeenCalled();
    await expect(store.getSampling(handle.samplingIds[0]!)).resolves.toMatchObject({ execution: { status: "queued" } });
  });

  it("runs execution with the plan's concurrency and harness", async () => {
    const store = makeStore({ plans: projectPlans() });
    const harness = makeHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(harness.materializeInitialData).mockImplementation(async () => {
      await gate;
      return { manifestHash: "manifest-1", target: "workspace", materials: [] };
    });
    store.plans().samples = store.plans().samples.map((sample) => ({ ...sample, samplingCount: 2 }));
    store.plans().execution = executionPlan({ executionConcurrency: 2 });
    const handle = await createTestAdmission(store)
      .submit(projectRequest("execution", "plan-concurrency", ["sample-1", "sample-2", "sample-3"]));
    expect(handle.samplingIds).toHaveLength(6);
    const task = createTestResumer(store, harness).resume(handle.runId);
    await vi.waitFor(() => expect(harness.materializeInitialData).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.materializeInitialData).toHaveBeenCalledTimes(2);
    release();
    await task;
    expect(harness.ensureAgent).toHaveBeenCalledTimes(6);
    expect(vi.mocked(harness.ensureAgent).mock.calls.every(([input]) => equalJson(input.agentConfig, SUBJECT) && input.framework === "sp"))
      .toBe(true);
  });
});

describe("Project Run stop", () => {
  function stopReporter() {
    return { finalizing: vi.fn<RunStopReporter["finalizing"]>(), stageStopped: vi.fn<RunStopReporter["stageStopped"]>() };
  }

  function stoppedRun() {
    const store = makeStore();
    const harness = makeHarness();
    const admission = createTestAdmission(store);
    const savedGetRun = store.getRun.bind(store);
    store.getRun = async (runId) => {
      const record = await savedGetRun(runId);
      return record ? { ...record, stopRequested: true } : null;
    };
    const resumer = createTestResumer(store, harness, { onError: vi.fn() });
    return { store, harness, admission, resumer };
  }

  it("cancels an unstarted Pipeline without dispatching either phase", async () => {
    const { store, harness, admission, resumer } = stoppedRun();
    const handle = await admission.submit(projectRequest("pipeline", "stop-queued-pipeline"));
    await resumer.stop(handle.runId);
    const run = (await store.getRun(handle.runId))!;
    const sampling = await saved(store, handle.samplingIds[0]!);
    const evaluation = await savedEvaluation(store, run.evaluationIds[0]!);
    expect(sampling.execution.status).toBe("cancelled");
    expect(evaluation.status.status).toBe("cancelled");
    expect(toRunSnapshot({ ...run, stopFinalized: true }, [sampling], [evaluation])).toMatchObject({
      stopRequested: true, stopFinalized: true, status: "cancelled",
    });
    expect(harness.ensureAgent).not.toHaveBeenCalled();
    expect(harness.submitAgent).not.toHaveBeenCalled();
  });

  it("reports an accepted stop as cancelled even if the last stage finished naturally", async () => {
    const { store, admission } = stoppedRun();
    const handle = await admission.submit(projectRequest("execution", "stop-natural-completion-race"));
    const run = (await store.getRun(handle.runId))!;
    const queued = await saved(store, handle.samplingIds[0]!);
    const succeeded: SamplingState = { ...queued, execution: { status: "succeeded" } };
    await store.updateSampling(succeeded, queued);
    expect(toRunSnapshot({ ...run, stopFinalized: true }, [succeeded], [])).toMatchObject({
      stopRequested: true, stopFinalized: true, status: "cancelled",
    });
  });

  it("leaves a blocked submission for stop cleanup without inventing resource facts", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const admission = createTestAdmission(store);
    const handle = await admission.submit(projectRequest("execution", "stop-before-submission"));
    const originalGate = store.withRunDispatchGate.bind(store);
    const originalGetRun = store.getRun.bind(store);
    let calls = 0;
    let stopped = false;
    store.withRunDispatchGate = async (runId, dispatch) => {
      calls += 1;
      if (calls === 3) {
        stopped = true;
        throw new RuntimeRunStoppedError(runId);
      }
      return originalGate(runId, dispatch);
    };
    store.getRun = async (runId) => {
      const run = await originalGetRun(runId);
      return run && stopped ? { ...run, stopRequested: true } : run;
    };
    const resumer = createTestResumer(store, harness);

    await resumer.resume(handle.runId);
    const beforeCleanup = await saved(store, handle.samplingIds[0]!);
    expect(stopped).toBe(true);
    expect(beforeCleanup.execution.status).toBe("starting");
    expect(beforeCleanup.executionAttempts[0]?.resources?.status).toBe("pending");
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.collectAgentResources).not.toHaveBeenCalled();

    await resumer.stop(handle.runId);
    const final = await saved(store, handle.samplingIds[0]!);
    expect(final.execution.status).toBe("cancelled");
    expect(final.executionAttempts[0]).toMatchObject({ status: "cancelled" });
    expect(final.executionAttempts[0]?.resources).toBeUndefined();
  });

  it("cancels a stage when SP rejects an in-flight submission after stop", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const admission = createTestAdmission(store);
    const handle = await admission.submit(projectRequest("execution", "stop-sp-latch-race"));
    let stopped = false;
    vi.mocked(harness.submitAgent).mockImplementation(async () => {
      stopped = true;
      throw Object.assign(new Error("SP rejected the stopped Chat"), { retryable: false, status: 409 });
    });
    const originalGetRun = store.getRun.bind(store);
    store.getRun = async (runId) => {
      const run = await originalGetRun(runId);
      return run && stopped ? { ...run, stopRequested: true } : run;
    };
    const resumer = createTestResumer(store, harness);

    await resumer.resume(handle.runId);
    const beforeCleanup = await saved(store, handle.samplingIds[0]!);
    expect(beforeCleanup.execution.status).toBe("failed");
    expect(beforeCleanup.executionAttempts[0]?.submissionId).toBeUndefined();

    await resumer.stop(handle.runId);
    const final = await saved(store, handle.samplingIds[0]!);
    expect(final.execution.status).toBe("cancelled");
    expect(final.executionAttempts[0]).toMatchObject({ status: "cancelled" });
    expect(final.executionAttempts[0]?.resources).toBeUndefined();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("cancels an Evaluator rejected by the stopped SP Chat latch", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const admission = createTestAdmission(store);
    const execution = await admission.submit(projectRequest("execution", "stop-evaluator-seed"));
    const samplingId = execution.samplingIds[0]!;
    const queued = await saved(store, samplingId);
    await store.updateSampling({
      ...queued,
      subjectChatId: "subject-chat-1",
      execution: { status: "succeeded" },
      artifacts: [{ artifactId: "subject-file", kind: "file", path: "/subject.txt" }],
      trajectory: { trajectoryId: "subject-trace", source: "subject", path: "/subject.jsonl" },
      evidence: SEEDED_EVIDENCE,
    }, queued);
    const handle = await admission.submit(evaluationRequest([samplingId], "stop-evaluator-latch"));
    let stopped = false;
    vi.mocked(harness.submitAgent).mockImplementation(async () => {
      stopped = true;
      throw Object.assign(new Error("SP rejected the stopped Chat"), { retryable: false, status: 409 });
    });
    const originalGetRun = store.getRun.bind(store);
    store.getRun = async (runId) => {
      const run = await originalGetRun(runId);
      return run && stopped ? { ...run, stopRequested: true } : run;
    };
    const resumer = createTestResumer(store, harness);

    await resumer.resume(handle.runId);
    const run = (await store.getRun(handle.runId))!;
    const beforeCleanup = await savedEvaluation(store, run.evaluationIds[0]!);
    expect(beforeCleanup.status.status).toBe("failed");
    expect(beforeCleanup.attempts[0]?.submissionId).toBeUndefined();

    await resumer.stop(handle.runId);
    const final = await savedEvaluation(store, run.evaluationIds[0]!);
    expect(final.status.status).toBe("cancelled");
    expect(final.attempts[0]).toMatchObject({ status: "cancelled" });
    expect(final.attempts[0]?.resources).toBeUndefined();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("cancels a failed Subject creation when the SP Chat does not exist", async () => {
    const { store, harness, admission, resumer } = stoppedRun();
    const handle = await admission.submit(projectRequest("execution", "stop-missing-subject-chat"));
    const samplingId = handle.samplingIds[0]!;
    const queued = await saved(store, samplingId);
    await store.updateSampling({
      ...queued, subjectChatId: "missing-subject-chat",
      execution: { status: "failed", lastError: "Chat creation failed" },
      executionAttempts: [{
        executionAttemptId: "attempt-before-chat", samplingId,
        attemptNumber: 1, status: "failed", completedAt: "2026-10-14T00:00:00.000Z",
      }],
    }, queued);
    vi.mocked(harness.inspectAgentOperation).mockRejectedValue(
      new AgentHandleNotFoundError("missing-subject-chat"),
    );

    await resumer.stop(handle.runId);

    const final = await saved(store, samplingId);
    expect(final.execution.status).toBe("cancelled");
    expect(final.executionAttempts[0]?.status).toBe("cancelled");
    expect(harness.submitAgent).not.toHaveBeenCalled();
  });

  it("cancels a failed Evaluator creation when its SP Chat does not exist", async () => {
    const { store, harness, admission, resumer } = stoppedRun();
    const execution = await admission.submit(projectRequest("execution", "stop-missing-evaluator-seed"));
    const samplingId = execution.samplingIds[0]!;
    const queued = await saved(store, samplingId);
    await store.updateSampling({
      ...queued,
      subjectChatId: "subject-chat-1", execution: { status: "succeeded" },
      artifacts: [{ artifactId: "subject-file", kind: "file", path: "/subject.txt" }],
      trajectory: { trajectoryId: "subject-trace", source: "subject", path: "/subject.jsonl" },
    }, queued);
    const handle = await admission.submit(evaluationRequest([samplingId], "stop-missing-evaluator-chat"));
    const run = (await store.getRun(handle.runId))!;
    const evaluationId = run.evaluationIds[0]!;
    const initial = await savedEvaluation(store, evaluationId);
    await store.updateEvaluation({
      ...initial, chatId: "missing-evaluator-chat",
      status: { status: "failed", lastError: "Chat creation failed" },
      attempts: [{
        evaluationAttemptId: "attempt-before-chat", evaluationId,
        attemptNumber: 1, status: "failed", completedAt: "2026-10-14T00:00:00.000Z",
      }],
    }, initial);
    vi.mocked(harness.inspectAgentOperation).mockRejectedValue(
      new AgentHandleNotFoundError("missing-evaluator-chat"),
    );

    await resumer.stop(handle.runId);

    const final = await savedEvaluation(store, evaluationId);
    expect(final.status.status).toBe("cancelled");
    expect(final.attempts[0]?.status).toBe("cancelled");
    expect(harness.submitAgent).not.toHaveBeenCalled();
  });

  it("does not erase a saved Submission ID when its SP Chat is missing", async () => {
    const { store, harness, admission, resumer } = stoppedRun();
    const handle = await admission.submit(projectRequest("execution", "stop-missing-claimed-submission"));
    const samplingId = handle.samplingIds[0]!;
    const queued = await saved(store, samplingId);
    const claimed: SamplingState = {
      ...queued, subjectChatId: "missing-claimed-chat",
      execution: { status: "starting" },
      executionAttempts: [{
        executionAttemptId: "claimed-attempt", samplingId, attemptNumber: 1,
        submissionId: "claimed-submission", status: "running",
      }],
    };
    await store.updateSampling(claimed, queued);
    vi.mocked(harness.inspectAgentOperation).mockRejectedValue(
      new AgentHandleNotFoundError("missing-claimed-chat"),
    );

    await expect(resumer.stop(handle.runId)).rejects.toBeInstanceOf(AggregateError);
    expect((await store.getSampling(samplingId))?.executionAttempts[0]?.submissionId)
      .toBe("claimed-submission");
  });

  it("interrupts a live Subject, preserving its artifacts and trajectory without reading resources", async () => {
    const { store, harness, admission, resumer } = stoppedRun();
    const handle = await admission.submit(projectRequest("execution", "stop-running-subject"));
    const samplingId = handle.samplingIds[0]!;
    const queued = await saved(store, samplingId);
    const active: SamplingState = {
      ...queued, subjectChatId: "subject-chat-1", execution: { status: "running" },
      executionAttempts: [{
        executionAttemptId: "attempt-1", samplingId, attemptNumber: 1,
        status: "running", resources: { status: "pending", scope: {
          chatId: "subject-chat-1", idempotencyKey: `execution:${samplingId}`,
        } },
      }],
    };
    await store.updateSampling(active, queued);
    vi.mocked(harness.stopAgent).mockResolvedValue();
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue({
      submissionId: "submission-1", status: "interrupted",
      retryable: false, error: "Evaluation Run stopped",
    });
    await resumer.stop(handle.runId);
    const result = await saved(store, samplingId);
    expect(result.execution.status).toBe("cancelled");
    expect(result.artifacts).toHaveLength(1);
    expect(result.trajectory?.source).toBe("subject");
    expect(result.executionAttempts[0]).toMatchObject({
      submissionId: "submission-1", status: "interrupted", completedAt: expect.any(String),
      resources: { status: "failed", scope: { chatId: "subject-chat-1", idempotencyKey: `execution:${samplingId}` }, error: "Run stopped before resources were collected" },
    });
    expect(harness.collectAgentResources).not.toHaveBeenCalled();
    expect(harness.stopAgent).toHaveBeenCalledWith({ handle: expect.objectContaining({ chatId: "subject-chat-1" }) });
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("retries stop and terminal status calls before finalizing a stopped Subject", async () => {
    const { store, harness, admission } = stoppedRun();
    const handle = await admission.submit(projectRequest("execution", "stop-idempotent-retry"));
    const samplingId = handle.samplingIds[0]!;
    const queued = await saved(store, samplingId);
    const active: SamplingState = {
      ...queued, subjectChatId: "subject-chat-1", execution: { status: "running" },
      executionAttempts: [{
        executionAttemptId: "attempt-1", samplingId, attemptNumber: 1,
        status: "running", resources: { status: "pending", scope: {
          chatId: "subject-chat-1", idempotencyKey: `execution:${samplingId}`,
        } },
      }],
    };
    await store.updateSampling(active, queued);
    vi.mocked(harness.stopAgent)
      .mockRejectedValueOnce(Object.assign(new Error("stop temporarily unavailable"), { retryable: true }))
      .mockResolvedValue();
    vi.mocked(harness.inspectAgentOperation)
      .mockRejectedValueOnce(Object.assign(new Error("status temporarily unavailable"), { retryable: true }))
      .mockResolvedValue({
        submissionId: "submission-1", status: "interrupted",
        retryable: false, error: "Evaluation Run stopped",
      });
    const resumer = createTestResumer(store, harness, {
      sleep: async () => undefined,
      createRetryController: createProductionRetryController,
    });

    await resumer.stop(handle.runId);

    expect(harness.stopAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(harness.inspectAgentOperation).mock.calls.length).toBeGreaterThan(1);
    expect((await store.getSampling(samplingId))?.execution.status).toBe("cancelled");
  });

  it("interrupts a live Evaluator, keeping its result without reading resources", async () => {
    const { store, harness, admission, resumer } = stoppedRun();
    const execution = await admission.submit(projectRequest("execution", "stop-evaluation-seed"));
    const samplingId = execution.samplingIds[0]!;
    const queued = await saved(store, samplingId);
    const succeeded: SamplingState = {
      ...queued, subjectChatId: "subject-chat-1", execution: { status: "succeeded" },
      artifacts: [{ artifactId: "subject-file", kind: "file", path: "/subject.txt" }],
      trajectory: { trajectoryId: "subject-trace", source: "subject", path: "/subject.jsonl" },
      evidence: SEEDED_EVIDENCE,
    };
    await store.updateSampling(succeeded, queued);
    const handle = await admission.submit(evaluationRequest([samplingId], "stop-evaluation"));
    const run = (await store.getRun(handle.runId))!;
    const evaluationId = run.evaluationIds[0]!;
    const initial = await savedEvaluation(store, evaluationId);
    const active: EvaluationState = {
      ...initial, chatId: "evaluation-chat-1", status: { status: "running" },
      attempts: [{
        evaluationAttemptId: "evaluation-attempt-1", evaluationId,
        attemptNumber: 1, status: "running", resources: { status: "pending", scope: {
          chatId: "evaluation-chat-1", idempotencyKey: `evaluation:${samplingId}`,
        } },
      }],
    };
    await store.updateEvaluation(active, initial);
    vi.mocked(harness.stopAgent).mockResolvedValue();
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue({
      submissionId: "evaluation-submission-1", status: "interrupted",
      retryable: false, error: "Evaluation Run stopped",
    });
    await resumer.stop(handle.runId);
    const result = await savedEvaluation(store, evaluationId);
    expect(result.status.status).toBe("cancelled");
    expect(result.output?.artifacts).toHaveLength(1);
    expect(result.output?.trajectory.source).toBe("evaluator");
    expect(result.attempts[0]).toMatchObject({
      submissionId: "evaluation-submission-1", status: "interrupted", completedAt: expect.any(String),
      resources: { status: "failed", scope: { chatId: "evaluation-chat-1", idempotencyKey: `evaluation:${samplingId}` },
        error: "Run stopped before resources were collected" },
    });
    expect(harness.collectAgentResources).not.toHaveBeenCalled();
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("does not restart a retryable Submission after the active Run receives a stop signal", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const admission = createTestAdmission(store);
    const handle = await admission.submit(projectRequest("execution", "stop-active-retry"));
    vi.mocked(harness.submitAgent).mockResolvedValue({
      submissionId: "active-submission", status: "running",
    });
    let finishWait!: (submission: AgentSubmission) => void;
    const waiting = new Promise<AgentSubmission>((resolve) => { finishWait = resolve; });
    vi.mocked(harness.waitForSubmission).mockImplementation(async () => waiting);
    const resumer = createTestResumer(store, harness);
    const controller = new AbortController();
    const task = resumer.resume(handle.runId, controller.signal);
    await vi.waitFor(() => expect(harness.waitForSubmission).toHaveBeenCalledOnce());
    controller.abort();
    finishWait({ submissionId: "active-submission", status: "interrupted", retryable: true, error: "Run stopped" });
    await task;
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("exits a stalled terminal wait on stop without marking raw resources failed", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const admission = createTestAdmission(store);
    const handle = await admission.submit(projectRequest("execution", "stop-stalled-terminal-wait"));
    vi.mocked(harness.submitAgent).mockResolvedValue({
      submissionId: "stalled-submission", status: "running",
    });
    vi.mocked(harness.waitForSubmission).mockImplementation(async () => new Promise(() => undefined));
    const resumer = createTestResumer(store, harness);
    const controller = new AbortController();
    const task = resumer.resume(handle.runId, controller.signal);
    await vi.waitFor(() => expect(harness.waitForSubmission).toHaveBeenCalledOnce());

    controller.abort();
    await task;

    const sampling = await saved(store, handle.samplingIds[0]!);
    expect(sampling.execution.status).toBe("starting");
    expect(sampling.executionAttempts[0]?.resources?.status).toBe("pending");
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("leaves a hung SP preparation when the Worker signals stop", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const admission = createTestAdmission(store);
    const handle = await admission.submit(projectRequest("execution", "stop-hung-preparation"));
    vi.mocked(harness.materializeInitialData).mockImplementation(async () => new Promise(() => undefined));
    const resumer = createTestResumer(store, harness);
    const controller = new AbortController();
    const task = resumer.resume(handle.runId, controller.signal);
    await vi.waitFor(() => expect(harness.materializeInitialData).toHaveBeenCalledOnce());
    const originalGetRun = store.getRun.bind(store);
    store.getRun = async (runId) => {
      const run = await originalGetRun(runId);
      return run ? { ...run, stopRequested: true } : null;
    };
    controller.abort();
    await task;
    await resumer.stop(handle.runId);

    expect((await store.getSampling(handle.samplingIds[0]!))?.execution.status).toBe("cancelled");
    expect(harness.submitAgent).not.toHaveBeenCalled();
  });

  it("cancels an interrupted Subject in one stop even when its output cannot be collected", async () => {
    const { store, harness, admission, resumer } = stoppedRun();
    const handle = await admission.submit(projectRequest("execution", "stop-evidence-retry"));
    const samplingId = handle.samplingIds[0]!;
    const queued = await saved(store, samplingId);
    const pending: SamplingState = {
      ...queued, subjectChatId: "evidence-chat", execution: { status: "retrying", evidencePending: true },
      executionAttempts: [{
        executionAttemptId: "terminal-attempt", samplingId, attemptNumber: 1,
        submissionId: "terminal-submission", status: "interrupted", completedAt: "2026-10-14T00:00:00.000Z",
      }],
    };
    await store.updateSampling(pending, queued);
    vi.mocked(harness.collectExecution).mockRejectedValueOnce(new Error("evidence unavailable"));
    const reporter = stopReporter();
    await resumer.stop(handle.runId, reporter);
    const stopped = await saved(store, samplingId);
    expect(stopped.execution).toEqual({ status: "cancelled", lastError: "Run stopped" });
    expect(stopped.executionAttempts).toEqual(pending.executionAttempts);
    expect(harness.stopAgent).not.toHaveBeenCalled();
    expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
    expect(reporter.stageStopped).toHaveBeenCalledExactlyOnceWith({
      stage: "execution", samplingId, status: "cancelled", reason: "agent-stopped",
    });
  });

  describe("an ended Agent whose results are still pending", () => {
    const ENDED_AT = "2026-10-14T00:00:01.000Z";
    const STOPPED_RESOURCES_ERROR = "Run stopped before resources were collected";
    const progress = {
      exportedAt: "2026-10-14T00:00:02.000Z",
      artifacts: [{ path: "/a.txt", size: 1, mediaType: "text/plain", sha256: "a".repeat(64) }],
      subjectInputs: [], omitted: [], trajectory: { format: SP_PI_TRAJECTORY_FORMAT, throughSeq: 200,
        afterSeq: 200, parts: [{ sha256: "b".repeat(64), size: 10, records: 200 }] },
    } satisfies EvidenceExportProgress;
    const collectedResources = (chatId: string, idempotencyKey: string, submissionId: string) => ({
      status: "collected" as const,
      summary: summarizeResourceSnapshot({
        scope: { chatId, idempotencyKey, submissionId }, observedAt: ENDED_AT, finalized: true,
        coverage: { usageEvents: "complete", nativeRecords: "complete", billingSettlements: "complete" },
        usageEvents: [], nativeRecords: [], billingSettlements: [],
      }),
    });

    async function endedSubject(key: string, execution: SamplingState["execution"], operation: "execution" | "pipeline" = "execution") {
      const fixture = stoppedRun();
      const handle = await fixture.admission.submit(projectRequest(operation, key));
      const samplingId = handle.samplingIds[0]!;
      const queued = await saved(fixture.store, samplingId);
      const ended: SamplingState = {
        ...queued, subjectChatId: "subject-chat", execution,
        artifacts: [{ artifactId: "subject-file", kind: "file", path: "/subject.txt" }],
        trajectory: { trajectoryId: "subject-trace", source: "subject", path: "/subject.jsonl" },
        evidenceExport: { submissionId: "subject-submission", passes: 2, lastError: "SP export failed", progress },
        executionAttempts: [{
          executionAttemptId: "subject-attempt", samplingId, attemptNumber: 1, status: "completed",
          submissionId: "subject-submission", startedAt: "2026-10-14T00:00:00.000Z", completedAt: ENDED_AT,
          resources: collectedResources("subject-chat", `execution:${samplingId}`, "subject-submission"),
        }],
      };
      await fixture.store.updateSampling(ended, queued);
      return { ...fixture, handle, samplingId, ended: await saved(fixture.store, samplingId) };
    }

    function expectNoAgentWork(harness: Harness): void {
      for (const call of [harness.ensureAgent, harness.materializeInitialData, harness.submitAgent, harness.restartAgent,
        harness.stopAgent, harness.exportEvidence, harness.importEvidence, harness.inspectAgentResources]) {
        expect(call).not.toHaveBeenCalled();
      }
    }

    it.each([
      ["evidence export", { status: "retrying", lastError: "SP export failed", evidencePending: true }, "evidence-export",
        "Run stopped before evidence export finished; last: SP export failed"],
      ["output collection", { status: "retrying", collectionPending: true }, "output-collection",
        "Run stopped before output collection finished"],
      ["a resource refresh", { status: "retrying", lastError: "SP export failed", evidencePending: true,
        resourcesPending: { deadline: "2026-10-14T00:11:00.000Z" } }, "evidence-export",
      "Run stopped before evidence export finished; last: SP export failed"],
    ] as const)("fails a completed Subject waiting for %s, keeping every saved fact", async (_kind, execution, reason, lastError) => {
      const { store, harness, handle, samplingId, ended } = await endedSubject(`stop-ended-${reason}-${_kind}`, execution);
      const reporter = stopReporter();

      await resumer(store, harness).stop(handle.runId, reporter);

      const stopped = await saved(store, samplingId);
      expect(stopped).toEqual({ ...ended, revision: expect.any(Number), execution: { status: "failed", lastError } });
      expectNoAgentWork(harness);
      expect(harness.collectExecution).not.toHaveBeenCalled();
      expect(reporter.finalizing).toHaveBeenCalledExactlyOnceWith({
        [`execution.retrying.${"collectionPending" in execution ? "collectionPending" : "evidencePending"}`]: 1,
      });
      expect(reporter.stageStopped).toHaveBeenCalledExactlyOnceWith({ stage: "execution", samplingId, status: "failed", reason });
    });

    it("saves best-effort output of a completed Subject once, then fails it with the collection error", async () => {
      const { store, harness, handle, samplingId, ended } = await endedSubject("stop-ended-uncollected", { status: "retrying", evidencePending: true });
      const { artifacts: _artifacts, trajectory: _trajectory, ...uncollected } = ended;
      await store.updateSampling(uncollected, ended);
      vi.mocked(harness.collectExecution).mockRejectedValue(new Error("SP output unavailable"));

      await resumer(store, harness).stop(handle.runId);

      expect(await saved(store, samplingId)).toEqual({
        ...uncollected, revision: expect.any(Number), execution: { status: "failed", lastError: "Run stopped before evidence export finished; last: execution output collection failed: SP output unavailable" },
      });
      expect(harness.collectExecution).toHaveBeenCalledOnce();
      expectNoAgentWork(harness);
    });

    it("cancels the queued Evaluation of a Pipeline Sampling that can no longer produce evidence", async () => {
      const { store, harness, handle, samplingId } = await endedSubject(
        "stop-ended-pipeline", { status: "retrying", evidencePending: true }, "pipeline",
      );
      const reporter = stopReporter();

      await resumer(store, harness).stop(handle.runId, reporter);

      const run = (await store.getRun(handle.runId))!;
      expect((await saved(store, samplingId)).execution.status).toBe("failed");
      expect((await savedEvaluation(store, run.evaluationIds[0]!)).status).toEqual({ status: "cancelled", lastError: "Run stopped" });
      expect(reporter.finalizing).toHaveBeenCalledExactlyOnceWith({ "execution.retrying.evidencePending": 1, "evaluation.queued": 1 });
      expect(reporter.stageStopped).toHaveBeenCalledWith({
        stage: "evaluation", samplingId, evaluationId: run.evaluationIds[0], status: "cancelled", reason: "not-started",
      });
      expectNoAgentWork(harness);
    });

    it("ends a finished stage's stale resource wait without reading SP", async () => {
      const { store, harness, handle, samplingId, ended } = await endedSubject("stop-finished-refresh", {
        status: "succeeded", resourcesPending: { deadline: "2026-10-14T00:11:00.000Z" },
      });

      await resumer(store, harness).stop(handle.runId);

      expect(await saved(store, samplingId)).toEqual({ ...ended, revision: expect.any(Number), execution: { status: "succeeded" } });
      expectNoAgentWork(harness);
      expect(harness.collectAgentResources).not.toHaveBeenCalled();
    });

    it.each([
      ["a succeeded", { status: "succeeded" }, { status: "succeeded" }],
      ["an evidence-export", { status: "retrying", evidencePending: true },
        { status: "failed", lastError: "Run stopped before evidence export finished" }],
    ] as const)("records the owed resources of %s stage as failed without reading SP when its Run stops", async (_kind, execution, stopped) => {
      const { store, harness, handle, samplingId, ended } = await endedSubject(`stop-owed-${_kind}`, {
        ...execution, resourcesPending: { deadline: "2026-10-14T00:11:00.000Z" },
      });
      const scope = { chatId: "subject-chat", idempotencyKey: `execution:${samplingId}`, submissionId: "subject-submission" };
      const owing: SamplingState = { ...ended, executionAttempts: [{ ...ended.executionAttempts[0]!, resources: { status: "pending", scope } }] };
      await store.updateSampling(owing, ended);
      const onError = vi.fn();

      await createTestResumer(store, harness, { onError }).stop(handle.runId);

      const saved_ = await saved(store, samplingId);
      expect(saved_.execution).toEqual(stopped);
      expect(saved_.executionAttempts[0]!.resources).toEqual({
        status: "failed", scope, collectedAt: expect.any(String), error: STOPPED_RESOURCES_ERROR,
      });
      expect(harness.collectAgentResources).not.toHaveBeenCalled();
      expect(harness.inspectAgentResources).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it("keeps an already collected, unfinalized snapshot when its Run stops", async () => {
      const { store, harness, handle, samplingId, ended } = await endedSubject("stop-owed-collected", {
        status: "succeeded", resourcesPending: { deadline: "2026-10-14T00:11:00.000Z" },
      });
      const [attempt] = ended.executionAttempts;
      const resources = collectedResources("subject-chat", `execution:${samplingId}`, "subject-submission");
      const unfinalized: SamplingState = {
        ...ended, executionAttempts: [{ ...attempt!, resources: { ...resources, summary: { ...resources.summary, finalized: false } } }],
      };
      await store.updateSampling(unfinalized, ended);

      await resumer(store, harness).stop(handle.runId);

      expect(await saved(store, samplingId)).toEqual({ ...unfinalized, revision: expect.any(Number), execution: { status: "succeeded" } });
      expect(harness.collectAgentResources).not.toHaveBeenCalled();
      expect(harness.inspectAgentResources).not.toHaveBeenCalled();
    });

    it("fails a completed Evaluator whose output collection is pending without validating or rerunning it", async () => {
      const { store, harness, admission } = stoppedRun();
      const execution = await admission.submit(projectRequest("execution", "stop-ended-evaluator-seed"));
      const samplingId = execution.samplingIds[0]!;
      const queued = await saved(store, samplingId);
      await store.updateSampling({
        ...queued, subjectChatId: "subject-chat", execution: { status: "succeeded" },
        artifacts: [{ artifactId: "subject-file", kind: "file", path: "/subject.txt" }],
        trajectory: { trajectoryId: "subject-trace", source: "subject", path: "/subject.jsonl" },
        evidence: SEEDED_EVIDENCE,
      }, queued);
      const handle = await admission.submit(evaluationRequest([samplingId], "stop-ended-evaluator"));
      const evaluationId = (await store.getRun(handle.runId))!.evaluationIds[0]!;
      const initial = await savedEvaluation(store, evaluationId);
      const pending: EvaluationState = {
        ...initial, chatId: "evaluator-chat", status: { status: "retrying", lastError: "output unavailable" },
        attempts: [{
          evaluationAttemptId: "evaluator-attempt", evaluationId, attemptNumber: 1, status: "completed",
          submissionId: "evaluator-submission", startedAt: "2026-10-14T00:00:00.000Z", completedAt: ENDED_AT,
          resources: collectedResources("evaluator-chat", `evaluation:${samplingId}`, "evaluator-submission"),
        }],
      };
      await store.updateEvaluation(pending, initial);
      vi.mocked(harness.collectEvaluation).mockRejectedValue(new Error("SP output unavailable"));
      const reporter = stopReporter();

      await resumer(store, harness).stop(handle.runId, reporter);

      expect(await savedEvaluation(store, evaluationId)).toEqual({
        ...pending, revision: expect.any(Number), status: { status: "failed", lastError: "Run stopped before output collection finished; last: evaluation output collection failed: SP output unavailable" },
      });
      expect(harness.collectEvaluation).toHaveBeenCalledOnce();
      expect(harness.readFinalReply).not.toHaveBeenCalled();
      expectNoAgentWork(harness);
      expect(reporter.stageStopped).toHaveBeenCalledExactlyOnceWith({
        stage: "evaluation", samplingId, evaluationId, status: "failed", reason: "output-collection",
      });
    });

    it("records an observed completion without exporting evidence or reading resources", async () => {
      const { store, harness, admission } = stoppedRun();
      const handle = await admission.submit(projectRequest("execution", "stop-observation-pending"));
      const samplingId = handle.samplingIds[0]!;
      const queued = await saved(store, samplingId);
      const scope = { chatId: "subject-chat", idempotencyKey: `execution:${samplingId}`, submissionId: "subject-submission" };
      await store.updateSampling({
        ...queued, subjectChatId: "subject-chat",
        execution: { status: "running", lastError: "socket closed", observationPending: { passes: 2, lastError: "socket closed" } },
        executionAttempts: [{
          executionAttemptId: "subject-attempt", samplingId, attemptNumber: 1, status: "running",
          submissionId: "subject-submission", startedAt: "2026-10-14T00:00:00.000Z", resources: { status: "pending", scope },
        }],
      }, queued);
      vi.mocked(harness.inspectAgentOperation).mockResolvedValue({ submissionId: "subject-submission", status: "completed" });
      vi.mocked(harness.inspectAgentResources).mockResolvedValue({
        scope, observedAt: ENDED_AT, finalized: false, readiness: FINALIZED_READINESS,
      });
      const sleep = vi.fn(async () => undefined);
      const reporter = stopReporter();

      await createTestResumer(store, harness, { sleep, createRetryController: createProductionRetryController }).stop(handle.runId, reporter);

      const stopped = await saved(store, samplingId);
      expect(stopped.execution).toEqual({ status: "failed", lastError: "Run stopped before evidence export finished" });
      expect(stopped.artifacts).toHaveLength(1);
      expect(stopped.executionAttempts[0]).toMatchObject({
        status: "completed", completedAt: expect.any(String),
        resources: { status: "failed", scope, collectedAt: expect.any(String), error: STOPPED_RESOURCES_ERROR },
      });
      expect(harness.inspectAgentResources).not.toHaveBeenCalled();
      expect(harness.collectAgentResources).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
      expect(harness.exportEvidence).not.toHaveBeenCalled();
      expect(harness.submitAgent).not.toHaveBeenCalled();
      expect(harness.restartAgent).not.toHaveBeenCalled();
      expect(reporter.finalizing).toHaveBeenCalledExactlyOnceWith({ "execution.running.observationPending": 1 });
    });

    it("cancels a stage whose status cannot be confirmed after its Chat was stopped", async () => {
      const { store, harness, admission } = stoppedRun();
      const handle = await admission.submit(projectRequest("execution", "stop-observation-unconfirmed"));
      const samplingId = handle.samplingIds[0]!;
      const queued = await saved(store, samplingId);
      const attempts: SamplingState["executionAttempts"] = [{
        executionAttemptId: "subject-attempt", samplingId, attemptNumber: 1, status: "running",
        submissionId: "subject-submission", startedAt: "2026-10-14T00:00:00.000Z",
        resources: { status: "pending", scope: { chatId: "subject-chat", idempotencyKey: `execution:${samplingId}`, submissionId: "subject-submission" } },
      }];
      await store.updateSampling({
        ...queued, subjectChatId: "subject-chat", executionAttempts: attempts,
        execution: { status: "running", lastError: "socket closed", observationPending: { passes: 2, lastError: "socket closed" } },
      }, queued);
      vi.mocked(harness.inspectAgentOperation).mockRejectedValue(new Error("SP status unavailable"));
      const reporter = stopReporter();

      await resumer(store, harness).stop(handle.runId, reporter);

      const stopped = await saved(store, samplingId);
      expect(stopped.execution).toEqual({ status: "cancelled", lastError: "Run stopped before its status was confirmed: SP status unavailable" });
      expect(stopped.executionAttempts).toEqual(attempts);
      expect(harness.stopAgent).toHaveBeenCalledOnce();
      expect(reporter.stageStopped).toHaveBeenCalledExactlyOnceWith({ stage: "execution", samplingId, status: "cancelled", reason: "status-unconfirmed" });
    });

    it("recollects the output of a finalized stop without reopening the stop or dispatching an Agent", async () => {
      const { store, harness, handle, samplingId, ended } = await endedSubject("stop-finalized-recollect", { status: "retrying", collectionPending: true });
      const getRun = store.getRun.bind(store);
      store.getRun = async (runId) => {
        const run = await getRun(runId);
        return run ? { ...run, stopFinalized: true } : null;
      };
      const runtime = resumer(store, harness);

      await runtime.stop(handle.runId);
      expect((await saved(store, samplingId)).execution).toEqual({ status: "retrying", collectionPending: true });
      await runtime.resume(handle.runId);

      const recollected = await saved(store, samplingId);
      expect(recollected.execution).toEqual({ status: "succeeded" });
      expect(recollected.evidence).toBeDefined();
      expect(recollected.executionAttempts).toEqual(ended.executionAttempts);
      for (const call of [harness.ensureAgent, harness.submitAgent, harness.restartAgent, harness.stopAgent]) expect(call).not.toHaveBeenCalled();
    });

    it("never starts a resource wait when recollecting the output of a finalized stop", async () => {
      const { store, harness, handle, samplingId, ended } = await endedSubject("stop-finalized-unfinalized", { status: "retrying", collectionPending: true });
      const [attempt] = ended.executionAttempts;
      const resources = collectedResources("subject-chat", `execution:${samplingId}`, "subject-submission");
      const unfinalized = { ...ended, executionAttempts: [{ ...attempt!, resources: { ...resources, summary: { ...resources.summary, finalized: false } } }] };
      await store.updateSampling(unfinalized, ended);
      const getRun = store.getRun.bind(store);
      store.getRun = async (runId) => {
        const run = await getRun(runId);
        return run ? { ...run, stopRequested: true, stopFinalized: true } : null;
      };

      await resumer(store, harness).resume(handle.runId);

      const recollected = await saved(store, samplingId);
      expect(recollected.execution).toEqual({ status: "succeeded" });
      expect(recollected.executionAttempts).toEqual(unfinalized.executionAttempts);
      expect(harness.inspectAgentResources).not.toHaveBeenCalled();
    });

    it("lets a manual resource recollection read the resources a finalized stop recorded as failed", async () => {
      const { store, harness, handle, samplingId, ended } = await endedSubject("stop-then-recollect-resources", {
        status: "succeeded", resourcesPending: { deadline: "2026-10-14T00:11:00.000Z" },
      });
      const scope = { chatId: "subject-chat", idempotencyKey: `execution:${samplingId}`, submissionId: "subject-submission" };
      await store.updateSampling({ ...ended, executionAttempts: [{ ...ended.executionAttempts[0]!, resources: { status: "pending", scope } }] }, ended);
      const runtime = resumer(store, harness);
      await runtime.stop(handle.runId);
      const stopped = await saved(store, samplingId);
      expect(stopped.executionAttempts[0]!.resources).toMatchObject({ status: "failed", error: STOPPED_RESOURCES_ERROR });
      const getRun = store.getRun.bind(store);
      store.getRun = async (runId) => {
        const run = await getRun(runId);
        return run ? { ...run, stopRequested: true, stopFinalized: true } : null;
      };
      const now = new Date().toISOString();
      await store.updateSampling({ ...stopped, execution: { status: "succeeded", resourcesPending: { deadline: now, nextAttemptAt: now } } }, stopped);

      await runtime.resume(handle.runId);

      const refreshed = await saved(store, samplingId);
      expect(refreshed.execution).toEqual({ status: "succeeded" });
      expect(refreshed.executionAttempts[0]!.resources).toMatchObject({ status: "collected", summary: { scope } });
      expect(harness.collectAgentResources).toHaveBeenCalledOnce();
    });

    function resumer(store: TestStore, harness: Harness) {
      return createTestResumer(store, harness, { onError: vi.fn() });
    }
  });

  it("retries stopped evidence collection before cancelling the stage", async () => {
    const { store, harness, admission } = stoppedRun();
    const handle = await admission.submit(projectRequest("execution", "stop-evidence-transient-retry"));
    const samplingId = handle.samplingIds[0]!;
    const queued = await saved(store, samplingId);
    const interrupted: SamplingState = {
      ...queued,
      subjectChatId: "evidence-chat",
      execution: { status: "failed", lastError: "Submission interrupted" },
      executionAttempts: [{
        executionAttemptId: "terminal-attempt", samplingId, attemptNumber: 1,
        submissionId: "terminal-submission", status: "interrupted", completedAt: "2026-10-14T00:00:00.000Z",
      }],
    };
    await store.updateSampling(interrupted, queued);
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue({
      submissionId: "terminal-submission", status: "interrupted",
    });
    vi.mocked(harness.collectExecution).mockRejectedValueOnce(
      Object.assign(new Error("evidence temporarily unavailable"), { retryable: true }),
    );
    const resumer = createTestResumer(store, harness, {
      sleep: async () => undefined,
      createRetryController: createProductionRetryController,
    });

    await resumer.stop(handle.runId);

    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
    expect((await store.getSampling(samplingId))?.execution.status).toBe("cancelled");
  });

  it("confirms persisted evidence after the store loses its write response", async () => {
    const { store, harness, admission, resumer } = stoppedRun();
    const handle = await admission.submit(projectRequest("execution", "stop-evidence-write-response-lost"));
    const samplingId = handle.samplingIds[0]!;
    const queued = await saved(store, samplingId);
    const interrupted: SamplingState = {
      ...queued,
      subjectChatId: "interrupted-chat",
      execution: { status: "failed", lastError: "Submission interrupted" },
      executionAttempts: [{
        executionAttemptId: "interrupted-attempt", samplingId, attemptNumber: 1,
        submissionId: "interrupted-submission", status: "interrupted",
        completedAt: "2026-10-14T00:00:00.000Z",
      }],
    };
    await store.updateSampling(interrupted, queued);
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue({
      submissionId: "interrupted-submission", status: "interrupted",
    });
    const updateSampling = store.updateSampling.bind(store);
    let lostResponse = false;
    store.updateSampling = async (next, expected) => {
      await updateSampling(next, expected);
      if (!lostResponse && next.artifacts && next.trajectory) {
        lostResponse = true;
        throw new Error("write response lost after commit");
      }
    };

    await resumer.stop(handle.runId);

    const persisted = await saved(store, samplingId);
    expect(lostResponse).toBe(true);
    expect(persisted.execution.status).toBe("cancelled");
    expect(persisted.artifacts).toHaveLength(1);
    expect(persisted.trajectory?.source).toBe("subject");
  });
});

describe("raw resource persistence", () => {
  it("persists scopes before dispatch and saves unchanged subject/evaluator records before output collection", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const captured: AgentResourceSnapshot[] = [];
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle, idempotencyKey }) => {
      const attempts = handle.role === "subject"
        ? (await saved(store, handle.samplingId)).executionAttempts
        : (await store.listEvaluations(handle.samplingId))[0]!.attempts;
      expect(attempts[0]!.resources).toEqual({
        status: "pending",
        scope: { chatId: handle.chatId, idempotencyKey },
      });
      return makeSubmission();
    });
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      const resources = makeResources(input);
      captured.push(resources);
      return resources;
    });
    const collectExecution = harness.collectExecution;
    vi.mocked(harness.collectExecution).mockImplementation(async (input) => {
      const sampling = await store.getSampling(input.handle.samplingId);
      expect(sampling!.executionAttempts[0]!.resources).toEqual({ status: "collected", summary: summarizeResourceSnapshot(captured[0]!) });
      return {
        samplingId: input.handle.samplingId,
        status: "succeeded",
        artifacts: [],
        trajectory: { trajectoryId: "subject-trace", source: "subject", path: "/eval/trace" },
      };
    });
    const runtime = createAutoResumingRuntime({ harness, store });
    const run = await runtime.submit(projectRequest("pipeline", "raw-pipeline"));
    const completed = await waitForTerminal(runtime, run.runId);

    expect(completed.status).toBe("succeeded");
    expect(captured).toHaveLength(2);
    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    const evaluation = await runtime.getEvaluation(completed.evaluationIds[0]!);
    expect(sampling.executionAttempts[0]!.resources).toEqual({ status: "collected", summary: summarizeResourceSnapshot(captured[0]!) });
    expect(evaluation.attempts[0]!.resources).toEqual({ status: "collected", summary: summarizeResourceSnapshot(captured[1]!) });
    expect(captured[0]!.scope.chatId).toBe(sampling.subjectChatId);
    expect(captured[1]!.scope.chatId).toBe(evaluation.chatId);
    expect(captured[1]!.scope.chatId).not.toBe(captured[0]!.scope.chatId);
    expect(captured[0]!.scope.submissionId).toBe(sampling.executionAttempts[0]!.submissionId);
    expect(captured[1]!.scope.submissionId).toBe(evaluation.attempts[0]!.submissionId);
    expect(vi.mocked(harness.collectAgentResources).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(collectExecution).mock.invocationCallOrder[0]!);
    expect(vi.mocked(harness.collectAgentResources).mock.invocationCallOrder[1]!)
      .toBeLessThan(vi.mocked(harness.collectEvaluation).mock.invocationCallOrder[0]!);
  });

  it("reads saved raw data from a new Runtime and isolates query results from persistence", async () => {
    const store = makeStore();
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const runtime = createAutoResumingRuntime({ harness, store });
    const run = await runtime.submit(projectRequest("pipeline", "cold-raw-query"));
    const completed = await waitForTerminal(runtime, run.runId);
    const originalSampling = await store.getSampling(run.samplingIds[0]!);
    const originalEvaluation = structuredClone(withoutRevision((await store.getEvaluation(completed.evaluationIds[0]!))!));
    const coldHarness = makeHarness();
    const cold = createAutoResumingRuntime({ harness: coldHarness, store });

    const sampling = await cold.getSampling(run.samplingIds[0]!);
    const evaluation = await cold.getEvaluation(completed.evaluationIds[0]!);
    const evaluations = await cold.listEvaluations(run.samplingIds[0]!);
    expect(sampling.executionAttempts).toEqual(originalSampling!.executionAttempts);
    expect(evaluation).toEqual(originalEvaluation);
    expect(evaluations).toEqual([originalEvaluation]);
    const collections = [sampling.executionAttempts[0]!.resources, evaluation.attempts[0]!.resources, evaluations[0]!.attempts[0]!.resources];
    for (const resources of collections) {
      if (resources?.status !== "collected") throw new Error("missing raw resources");
      Reflect.set(resources.summary.counts, "changedByConsumer", true);
    }
    expect(await cold.getSampling(run.samplingIds[0]!)).toEqual(await runtime.getSampling(run.samplingIds[0]!));
    expect(await cold.getEvaluation(completed.evaluationIds[0]!)).toEqual(originalEvaluation);
    expect(await cold.listEvaluations(run.samplingIds[0]!)).toEqual([originalEvaluation]);
    expect(originalSampling!.executionAttempts[0]!.resources).not.toHaveProperty("summary.counts.changedByConsumer");
    expect(coldHarness.ensureAgent).not.toHaveBeenCalled();
    expect(coldHarness.collectAgentResources).not.toHaveBeenCalled();
  });

  it.each(["failed", "interrupted", "cancelled"] as const)("retains %s subject resource records and the original error", async (status) => {
    const harness = makeHarness();
    const captured: AgentResourceSnapshot[] = [];
    vi.mocked(harness.submitAgent).mockResolvedValue({
      submissionId: "submission-1",
      status, retryable: false, error: `subject ${status}`,
    });
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      const resources = makeResources(input);
      captured.push(resources);
      return resources;
    });
    const runtime = createAutoResumingRuntime({ harness, store: makeStore() });
    const run = await runtime.submit(projectRequest("execution", `raw-subject-${status}`));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.execution.lastError).toBe(`subject ${status}`);
    expect(sampling.executionAttempts[0]!.resources).toEqual({ status: "collected", summary: summarizeResourceSnapshot(captured[0]!) });
    expect(harness.collectExecution).toHaveBeenCalledOnce();
    expect(sampling.artifacts).toEqual([{ artifactId: "artifact-1", kind: "project", path: "/eval/output" }]);
    expect(sampling.trajectory).toEqual({ trajectoryId: "trajectory-1", source: "subject", path: "/eval/trajectory.jsonl" });
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it.each(["failed", "interrupted", "cancelled"] as const)("retains %s evaluator records without changing the subject", async (status) => {
    const harness = makeHarness();
    const captured: AgentResourceSnapshot[] = [];
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => (
      handle.role === "subject" ? makeSubmission() : {
        submissionId: "submission-1",
        status, retryable: false, error: `evaluator ${status}`,
      }
    ));
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      const resources = makeResources(input);
      captured.push(resources);
      return resources;
    });
    const runtime = createAutoResumingRuntime({ harness, store: makeStore() });
    const run = await runtime.submit(projectRequest("pipeline", `raw-evaluator-${status}`));
    const completed = await waitForTerminal(runtime, run.runId);

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    const evaluation = await runtime.getEvaluation(completed.evaluationIds[0]!);
    expect(sampling.execution.status).toBe("succeeded");
    expect(sampling.executionAttempts[0]!.resources).toEqual({ status: "collected", summary: summarizeResourceSnapshot(captured[0]!) });
    expect(evaluation.status).toEqual({ status: "failed", lastError: `evaluator ${status}` });
    expect(evaluation.attempts[0]!.resources).toEqual({ status: "collected", summary: summarizeResourceSnapshot(captured[1]!) });
    expect(harness.collectEvaluation).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it.each(["subject", "evaluator"] as const)("saves the previous %s attempt's raw data before restarting", async (role) => {
    const store = makeStore();
    const harness = makeHarness();
    const captured: AgentResourceSnapshot[] = [];
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => (
      handle.role !== role ? makeSubmission() : {
        submissionId: "submission-1",
        status: "failed", retryable: true, error: "temporary LLM failure", failureKind: "llm",
      }
    ));
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      const resources = makeResources(input);
      captured.push(resources);
      return resources;
    });
    vi.mocked(harness.restartAgent).mockImplementation(async ({ handle }) => {
      const attempts = role === "subject"
        ? (await saved(store, handle.samplingId)).executionAttempts
        : (await store.listEvaluations(handle.samplingId))[0]!.attempts;
      expect(attempts[0]!.resources?.status).toBe("collected");
      return makeSubmission();
    });
    const runtime = createAutoResumingRuntime({ harness, store, sleep: async () => undefined });
    if (role === "subject") runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const execution = await runtime.submit(projectRequest("execution", "raw-before-restart"));
    await waitForTerminal(runtime, execution.runId);
    runtime.plans.evaluation = evaluationPlan({ retryPolicy: RETRY_ONE });
    const run = role === "subject" ? execution : await runtime.submit(evaluationRequest(execution.samplingIds));
    const completed = await waitForTerminal(runtime, run.runId);
    const attempts = role === "subject"
      ? (await runtime.getSampling(run.samplingIds[0]!)).executionAttempts
      : (await runtime.getEvaluation(completed.evaluationIds[0]!)).attempts;
    const stageResources = role === "subject" ? captured : captured.slice(1);

    expect(completed.status).toBe("succeeded");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.resources).toEqual({ status: "collected", summary: summarizeResourceSnapshot(stageResources[0]!) });
    expect(attempts[1]!.resources).toEqual({ status: "collected", summary: summarizeResourceSnapshot(stageResources[1]!) });
    expect(stageResources[1]!.scope.submissionId).toBe(stageResources[0]!.scope.submissionId);
    expect(stageResources[1]!.scope.idempotencyKey).toBe(`${role === "subject" ? "execution" : "evaluation"}:${run.samplingIds[0]}:restart:2`);
    expect(harness.restartAgent).toHaveBeenCalledTimes(1);
  });

  it("gives raw-resource reads and output reads separate retry budgets without rerunning the Agent", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources)
      .mockRejectedValueOnce(new Error("temporary resource read failure"))
      .mockImplementation(async (input) => makeResources(input));
    vi.mocked(harness.collectExecution).mockRejectedValueOnce(new Error("temporary artifact read failure"));
    const store = makeStore();
    const update = store.updateSampling.bind(store);
    let failResourceSave = true;
    vi.spyOn(store, "updateSampling").mockImplementation(async (record, expected) => {
      if (failResourceSave && record.executionAttempts[0]?.resources?.status === "collected") {
        failResourceSave = false;
        throw new Error("temporary resource persistence failure");
      }
      await update(record, expected);
    });
    const runtime = createAutoResumingRuntime({
      harness, store, sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ resources: 1, collection: 1, persistence: 1 }),
    });
    const run = await runtime.submit(projectRequest("execution", "independent-resource-retry"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

    const reads = vi.mocked(harness.collectAgentResources).mock.calls;
    expect(reads).toHaveLength(2);
    expect(reads[1]![0]).toEqual(reads[0]![0]);
    expect(harness.collectExecution).toHaveBeenCalledTimes(2);
    expect(harness.ensureAgent).toHaveBeenCalledTimes(1);
    expect(harness.submitAgent).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect((await runtime.getSampling(run.samplingIds[0]!)).executionAttempts[0]!.resources?.status).toBe("collected");
  });

  it("does not turn successful execution/evaluation into failure when resource reads are exhausted", async () => {
    const harness = makeHarness();
    const onError = vi.fn();
    vi.mocked(harness.collectAgentResources).mockRejectedValue(new Error("resource source unavailable"));
    const runtime = createAutoResumingRuntime({
      harness, store: makeStore(), onError, sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ resources: 1 }),
    });
    const run = await runtime.submit(projectRequest("pipeline", "missing-resources-pipeline"));
    const completed = await waitForTerminal(runtime, run.runId);
    expect(completed.status).toBe("succeeded");
    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    const evaluation = await runtime.getEvaluation(completed.evaluationIds[0]!);
    for (const resources of [sampling.executionAttempts[0]!.resources, evaluation.attempts[0]!.resources]) {
      expect(resources).toMatchObject({
        status: "failed", error: "resource source unavailable", collectedAt: expect.any(String),
      });
      expect(resources).not.toHaveProperty("snapshot");
    }
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(4);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.collectExecution).toHaveBeenCalledTimes(1);
    expect(harness.collectEvaluation).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls.map(([, context]) => context.stage)).toEqual(["execution", "evaluation"]);
    await runtime.resume(run.runId);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("waits on evaluator readiness after a terminal submission and downloads its snapshot once", async () => {
    const harness = makeHarness();
    let evaluatorChecks = 0;
    mockReadiness(harness, (input) => input.handle.role !== "evaluator" || ++evaluatorChecks > 1);
    const runtime = createAutoResumingRuntime({ harness, store: makeStore(), sleep: async () => undefined });
    const run = await runtime.submit(projectRequest("pipeline", "wait-evaluator-readiness"));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

    const evaluation = await runtime.getEvaluation((await runtime.getRun(run.runId)).evaluationIds[0]!);
    expect(evaluation.status).toEqual({ status: "succeeded" });
    expect(evaluation.attempts[0]?.resources).toMatchObject({ status: "collected", summary: { finalized: true } });
    expect(evaluatorChecks).toBe(2);
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(2);
  });

  it("leaves an unfinalized evaluator snapshot owed without downloading it", async () => {
    const harness = makeHarness();
    mockReadiness(harness, (input) => input.handle.role !== "evaluator");
    const runtime = createAutoResumingRuntime({ harness, store: makeStore(), sleep: async () => undefined });
    const run = await runtime.submit(projectRequest("pipeline", "owe-unfinalized-evaluator-resources"));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

    const evaluation = await runtime.getEvaluation((await runtime.getRun(run.runId)).evaluationIds[0]!);
    expect(evaluation.status).toEqual({ status: "succeeded", resourcesPending: { deadline: expect.any(String), nextAttemptAt: expect.any(String) } });
    expect(evaluation.attempts[0]?.resources?.status).toBe("pending");
    expect(vi.mocked(harness.collectAgentResources).mock.calls.map(([input]) => input.handle.role)).toEqual(["subject"]);
  });

  it("treats a readiness report for another Submission as not ready, without retrying or downloading", async () => {
    const harness = makeHarness();
    const decide = vi.fn(async () => ({ shouldRetry: true, backoffMs: 0 }));
    vi.mocked(harness.inspectAgentResources).mockImplementation(async (input) => ({
      scope: { chatId: input.handle.chatId, idempotencyKey: input.idempotencyKey, submissionId: "different-submission" },
      observedAt: "2026-10-08T00:00:00.000Z", finalized: true, readiness: FINALIZED_READINESS,
    }));
    const runtime = createAutoResumingRuntime({ harness, store: makeStore(), sleep: async () => undefined, createRetryController: () => ({ decide }) });
    const run = await runtime.submit(projectRequest("execution", "readiness-wrong-scope"));

    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts[0]!.resources?.status).toBe("pending");
    expect(sampling.execution.resourcesPending).toBeDefined();
    expect(harness.inspectAgentResources).toHaveBeenCalledOnce();
    expect(decide).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "resources" }));
    expect(harness.collectAgentResources).not.toHaveBeenCalled();
  });

  it("preserves the original Agent failure when its resource read also fails", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValue({
      submissionId: "submission-1",
      status: "failed", retryable: false, error: "original agent failure",
    });
    vi.mocked(harness.collectAgentResources).mockRejectedValue(new Error("resource source unavailable"));
    const runtime = createAutoResumingRuntime({ harness, store: makeStore() });
    const run = await runtime.submit(projectRequest("execution", "agent-and-resources-failed"));
    await waitForTerminal(runtime, run.runId);
    const sampling = await runtime.getSampling(run.samplingIds[0]!);

    expect(sampling.execution.lastError).toBe("original agent failure");
    expect(sampling.executionAttempts[0]!.error).toBe("original agent failure");
    expect(sampling.executionAttempts[0]!.resources).toMatchObject({ status: "failed", error: "resource source unavailable" });
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("does not retry invalid source attribution or publish those records as this Agent's facts", async () => {
    const harness = makeHarness();
    const decide = vi.fn(async () => ({ shouldRetry: true, backoffMs: 0 }));
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => ({
      ...makeResources(input), scope: { chatId: input.handle.chatId, submissionId: "different-submission", idempotencyKey: input.idempotencyKey },
    }));
    const runtime = createAutoResumingRuntime({
      harness, store: makeStore(), createRetryController: () => ({ decide }),
    });
    const run = await runtime.submit(projectRequest("execution", "wrong-resource-scope"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

    const resources = (await runtime.getSampling(run.samplingIds[0]!)).executionAttempts[0]!.resources;
    expect(resources).toMatchObject({ status: "failed", error: "Resource snapshot does not match the requested operation scope" });
    expect(resources).not.toHaveProperty("snapshot");
    expect(decide).not.toHaveBeenCalled();
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(1);
  });

  it.each(["creation", "initialization"] as const)("does not collect or invent usage before a failed %s", async (operation) => {
    const harness = makeHarness();
    if (operation === "creation") {
      vi.mocked(harness.ensureAgent).mockRejectedValue(new Error("creation failed"));
    } else {
      vi.mocked(harness.materializeInitialData).mockRejectedValue(new Error("initialization failed"));
    }
    const runtime = createAutoResumingRuntime({ harness, store: makeStore() });
    const run = await runtime.submit(projectRequest("execution", `no-resources-before-${operation}`));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    expect(harness.collectAgentResources).not.toHaveBeenCalled();
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect((await runtime.getSampling(run.samplingIds[0]!)).executionAttempts[0]).not.toHaveProperty("resources");
  });

  it("exposes pending collection while awaiting a pushed terminal state", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValue({ submissionId: "submission-1", status: "running" });
    let release!: (submission: AgentSubmission) => void;
    let reachedWait!: () => void;
    const waiting = new Promise<void>((resolve) => { reachedWait = resolve; });
    const terminal = new Promise<AgentSubmission>((resolve) => { release = resolve; });
    vi.mocked(harness.waitForSubmission).mockImplementation(async () => {
      reachedWait();
      return terminal;
    });
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const runtime = createAutoResumingRuntime({ harness, store: makeStore() });
    const run = await runtime.submit(projectRequest("execution", "pending-resources"));
    await waiting;

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts[0]!.submissionId).toBe("submission-1");
    expect(sampling.executionAttempts[0]!.resources).toEqual({
      status: "pending",
      scope: { chatId: sampling.subjectChatId, idempotencyKey: `execution:${sampling.samplingId}` },
    });
    expect(harness.collectAgentResources).not.toHaveBeenCalled();
    release(makeSubmission());
    await waitForTerminal(runtime, run.runId);
    expect((await runtime.getSampling(run.samplingIds[0]!)).executionAttempts[0]!.resources?.status).toBe("collected");
  });

  it.each(["submission", "status"] as const)("saves a finalized snapshot after uncertain %s without interpreting source completeness", async (operation) => {
    const harness = makeHarness();
    if (operation === "submission") {
      vi.mocked(harness.submitAgent).mockRejectedValue(new Error("submission response lost"));
      vi.mocked(harness.inspectAgentOperation).mockResolvedValue(null);
    } else {
      vi.mocked(harness.submitAgent).mockResolvedValue({ submissionId: "submission-1", status: "running" });
      vi.mocked(harness.waitForSubmission).mockRejectedValue(new Error("status source unavailable"));
      vi.mocked(harness.inspectAgentOperation).mockResolvedValue({ submissionId: "submission-1", status: "running" });
    }
    mockReadiness(harness, () => true);
    let captured!: AgentResourceSnapshot;
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      captured = {
        ...makeResources(input),
        coverage: { usageEvents: "partial", nativeRecords: "partial", billingSettlements: "unavailable" },
        billingSettlements: [],
      };
      return captured;
    });
    const runtime = createAutoResumingRuntime({ harness, store: makeStore() });
    const run = await runtime.submit(projectRequest("execution", `uncertain-${operation}-raw-data`));
    if (operation === "status") {
      // An unconfirmed status is re-observed on later passes before the stage fails.
      await vi.waitFor(async () => expect((await runtime.getSampling(run.samplingIds[0]!)).execution.observationPending).toBeDefined());
      for (let pass = 2; pass <= OBSERVATION_MAX_PASSES; pass += 1) await runtime.resume(run.runId);
    }
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts[0]!.resources).toEqual({ status: "collected", summary: summarizeResourceSnapshot(captured) });
    expect(sampling.executionAttempts[0]!.submissionId).toBe(captured.scope.submissionId);
    expect(sampling.execution.lastError).toContain(operation === "submission" ? "submission response lost" : "status source unavailable");
    expect(harness.collectExecution).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("does not download resources of an unconfirmed dispatch that SP has not finalized", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockRejectedValue(new Error("submission response lost"));
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue(null);
    mockReadiness(harness, () => false);
    const runtime = createAutoResumingRuntime({ harness, store: makeStore(), sleep: async () => undefined });
    const run = await runtime.submit(projectRequest("execution", "uncertain-unfinalized-resources"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "failed" });

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts[0]!.resources?.status).toBe("pending");
    expect(sampling.execution).not.toHaveProperty("resourcesPending");
    expect(harness.inspectAgentResources).toHaveBeenCalledOnce();
    expect(harness.collectAgentResources).not.toHaveBeenCalled();
  });

  it("replaces a re-evaluated record while keeping execution raw records unchanged", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const store = makeStore();
    const runtime = createAutoResumingRuntime({ harness, store });
    const execution = await runtime.submit(projectRequest("execution", "raw-execution-for-reevaluation"));
    await waitForTerminal(runtime, execution.runId);
    const subjectBefore = await runtime.getSampling(execution.samplingIds[0]!);
    const first = await runtime.submit(evaluationRequest(execution.samplingIds));
    const firstRun = await waitForTerminal(runtime, first.runId);
    const firstBefore = await runtime.getEvaluation(firstRun.evaluationIds[0]!);
    const second = await runtime.submit(evaluationRequest(execution.samplingIds));
    const secondRun = await waitForTerminal(runtime, second.runId);
    const secondEvaluation = await runtime.getEvaluation(secondRun.evaluationIds[0]!);

    expect(await runtime.getSampling(execution.samplingIds[0]!)).toEqual(subjectBefore);
    await expect(store.getEvaluation(firstBefore.evaluationId)).resolves.toBeNull();
    expect(await runtime.listEvaluations(execution.samplingIds[0]!)).toEqual([secondEvaluation]);
    expect(secondEvaluation.chatId).not.toBe(firstBefore.chatId);
    expect(firstBefore.attempts[0]!.resources).toMatchObject({ summary: { scope: { chatId: firstBefore.chatId, submissionId: firstBefore.attempts[0]!.submissionId } } });
    expect(secondEvaluation.attempts[0]!.resources).toMatchObject({ summary: { scope: { chatId: secondEvaluation.chatId, submissionId: secondEvaluation.attempts[0]!.submissionId } } });
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(3);
  });

  it("recovers saved raw facts when Evaluation finalization cannot be persisted", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const store = makeStore();
    const update = store.updateEvaluation.bind(store);
    let remainingFailures = 2;
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected, resources) => {
      if ((record.status.status === "succeeded" || record.status.status === "failed") && remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("terminal persistence failed");
      }
      await update(record, expected, resources);
    });
    const onError = vi.fn();
    const runtime = createAutoResumingRuntime({ harness, store, onError });
    const run = await runtime.submit(projectRequest("pipeline", "retain-raw-on-store-error"));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const pending = await runtime.getRun(run.runId);
    expect(pending.status).toBe("running");
    const original = await runtime.getEvaluation(pending.evaluationIds[0]!);
    expect(original.attempts[0]!.resources?.status).toBe("collected");

    await createRuntime({ harness, store }).resume(run.runId);
    const completed = await runtime.getRun(run.runId);
    const evaluation = await runtime.getEvaluation(completed.evaluationIds[0]!);

    expect(completed.status).toBe("succeeded");
    expect(evaluation.attempts).toHaveLength(1);
    expect(evaluation.attempts[0]!.resources?.status).toBe("collected");
    expect(store.resourceSnapshot({
      samplingId: evaluation.samplingId, evaluationId: evaluation.evaluationId, attemptId: evaluation.attempts[0]!.evaluationAttemptId,
    })).toHaveProperty("usageEvents.0.sourceExtension");
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.submitAgent).toHaveBeenCalledTimes(2);
  });

  it("does not publish success or restart when the raw snapshot cannot be committed", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const store = makeStore();
    const update = store.updateSampling.bind(store);
    let unavailable = true;
    vi.spyOn(store, "updateSampling").mockImplementation(async (state, expected) => {
      if (unavailable && state.executionAttempts.some((attempt) => attempt.resources?.status === "collected")) {
        throw new Error("raw resource persistence failed");
      }
      await update(state, expected);
    });
    const onError = vi.fn();
    const runtime = createAutoResumingRuntime({ harness, store, onError });
    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await runtime.submit(projectRequest("execution", "raw-store-failed"));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect((await runtime.getRun(run.runId)).status).toBe("running");
    expect(sampling.executionAttempts[0]!.status).toBe("completed");
    expect(sampling.executionAttempts[0]).not.toHaveProperty("error");
    expect(sampling.executionAttempts[0]!.resources?.status).toBe("pending");
    expect(harness.collectExecution).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
    unavailable = false;
    await runtime.resume(run.runId);
    expect((await runtime.getRun(run.runId)).status).toBe("succeeded");
    expect(harness.submitAgent).toHaveBeenCalledOnce();
  });

  it("commits each raw snapshot in the same record write that marks it collected", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const store = makeStore();
    const update = vi.spyOn(store, "updateSampling");
    const runtime = createAutoResumingRuntime({ harness, store });
    const run = await runtime.submit(projectRequest("execution", "snapshot-with-summary"));
    await expect.poll(async () => (await runtime.getRun(run.runId)).status).toBe("succeeded");

    const writes = update.mock.calls.filter(([, , resources]) => resources !== undefined);
    expect(writes).toHaveLength(1);
    const [state, , resources] = writes[0]!;
    const attempt = state.executionAttempts.find((item) => item.executionAttemptId === resources!.attemptId)!;
    if ("kind" in resources!.snapshot) throw new Error("Test Store did not receive its legacy fixture");
    expect(attempt.resources).toEqual({ status: "collected", summary: summarizeResourceSnapshot(resources!.snapshot) });
    expect(update.mock.calls.findIndex(([record]) => record.executionAttempts.some((item) => item.resources?.status === "collected")))
      .toBe(update.mock.calls.indexOf(writes[0]!));
  });

  it("retains raw data when completed Agent output collection fails", async () => {
    const harness = makeHarness();
    let captured!: AgentResourceSnapshot;
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      captured = makeResources(input);
      return captured;
    });
    vi.mocked(harness.collectExecution).mockRejectedValue(new Error("artifact read unavailable"));
    const runtime = createAutoResumingRuntime({ harness, store: makeStore() });
    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await runtime.submit(projectRequest("execution", "raw-before-output-failure"));
    await expect.poll(async () => (await runtime.getSampling(run.samplingIds[0]!)).execution.evidencePending).toBe(true);

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts[0]!.status).toBe("completed");
    expect(sampling.executionAttempts[0]).not.toHaveProperty("error");
    expect(sampling.executionAttempts[0]!.resources).toEqual({ status: "collected", summary: summarizeResourceSnapshot(captured) });
    expect(sampling.execution.lastError).toContain("artifact read unavailable");
    expect(sampling.execution.status).toBe("retrying");
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("preserves repeated source records across restart snapshots for Metric to interpret", async () => {
    const harness = makeHarness();
    const repeatedUsage = { eventId: "original-source-id", metrics: { inputTokens: 10 }, providerSpecificField: null };
    const repeatedSettlement = { accountId: "user-1", eventId: "original-source-id", debitedUnits: 1 };
    vi.mocked(harness.submitAgent).mockResolvedValue({
      submissionId: "submission-1",
      status: "failed", retryable: true, error: "agent request failed",
    });
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => ({
      ...makeResources(input), usageEvents: [repeatedUsage], billingSettlements: [repeatedSettlement],
    }));
    const store = makeStore();
    const runtime = createAutoResumingRuntime({ harness, store, sleep: async () => undefined });
    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await runtime.submit(projectRequest("execution", "raw-source-repeats"));
    await expect(waitForTerminal(runtime, run.runId)).resolves.toMatchObject({ status: "succeeded" });

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.executionAttempts).toHaveLength(2);
    for (const attempt of sampling.executionAttempts) {
      expect(attempt.resources).toMatchObject({ status: "collected", summary: { counts: { usageEvents: 1, billingSettlements: 1 } } });
      expect(store.resourceSnapshot({ samplingId: sampling.samplingId, attemptId: attempt.executionAttemptId }))
        .toMatchObject({ usageEvents: [repeatedUsage], billingSettlements: [repeatedSettlement] });
    }
  });

  it.each(["subject", "evaluator"] as const)("retains committed %s raw records after a lost Store response", async (role) => {
    const harness = makeHarness();
    let captured!: AgentResourceSnapshot;
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      const resources = makeResources(input);
      if (input.handle.role === role) captured = resources;
      return resources;
    });
    const store = makeStore();
    let loseResponse = true;
    if (role === "subject") {
      const update = store.updateSampling.bind(store);
      vi.spyOn(store, "updateSampling").mockImplementation(async (state, expected) => {
        await update(state, expected);
        if (loseResponse && state.executionAttempts.some((attempt) => attempt.resources?.status === "collected")) {
          loseResponse = false;
          throw new Error("raw write response lost");
        }
      });
    } else {
      const update = store.updateEvaluation.bind(store);
      vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected) => {
        await update(record, expected);
        if (loseResponse && record.attempts.some((attempt) => attempt.resources?.status === "collected")) {
          loseResponse = false;
          throw new Error("raw write response lost");
        }
      });
    }
    const runtime = createAutoResumingRuntime({ harness, store });
    const execution = await runtime.submit(projectRequest("execution", `lost-${role}-raw-store-response`));
    await waitForTerminal(runtime, execution.runId);
    const run = role === "subject" ? execution : await runtime.submit(evaluationRequest(execution.samplingIds));
    const completed = await waitForTerminal(runtime, run.runId);
    const attempts = role === "subject"
      ? (await runtime.getSampling(run.samplingIds[0]!)).executionAttempts
      : (await runtime.getEvaluation(completed.evaluationIds[0]!)).attempts;

    expect(completed.status).toBe("succeeded");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("completed");
    expect(attempts[0]).not.toHaveProperty("error");
    expect(attempts[0]!.resources).toEqual({ status: "collected", summary: summarizeResourceSnapshot(captured) });
    expect(role === "subject" ? harness.collectExecution : harness.collectEvaluation).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });
});

describe.each(["subject", "evaluator"] as const)("%s finalization", (role) => {
  it.each((["terminal", "resources", "output"] as const).flatMap((step) => (
    (["before", "after"] as const).map((failure) => ({ step, failure }))
  )))("recovers $step save errors $failure commit without rerunning or recollecting", async ({ step, failure }) => {
    const harness = makeHarness();
    const store = makeStore();
    let failedRecord: SamplingState | EvaluationRecord | undefined;
    let retriedRecord: SamplingState | EvaluationRecord | undefined;
    const save = async <TRecord extends SamplingState | EvaluationRecord>(
      record: TRecord,
      expected: TRecord,
      update: (record: TRecord, expected: TRecord) => Promise<void>,
    ): Promise<void> => {
      const attempts = "executionAttempts" in record ? record.executionAttempts : record.attempts;
      const status = "execution" in record ? record.execution.status : record.status.status;
      const shouldFail = step === "terminal"
        ? attempts[0]?.status === "completed" && attempts[0]?.resources?.status === "pending"
        : step === "resources"
          ? attempts[0]?.resources?.status === "collected"
          : status === "succeeded";
      if (shouldFail && !failedRecord) {
        failedRecord = structuredClone(record);
        if (failure === "after") await update(record, expected);
        throw new Error(`${step} write unavailable`);
      }
      if (failedRecord && !retriedRecord) retriedRecord = structuredClone(record);
      await update(record, expected);
    };
    if (role === "subject") {
      const update = store.updateSampling.bind(store);
      vi.spyOn(store, "updateSampling").mockImplementation((record, expected) => save(record, expected, update));
    } else {
      const update = store.updateEvaluation.bind(store);
      vi.spyOn(store, "updateEvaluation").mockImplementation((record, expected) => save(record, expected, update));
    }
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => {
      const attempts = input.handle.role === "subject"
        ? (await saved(store, input.handle.samplingId)).executionAttempts
        : (await store.listEvaluations(input.handle.samplingId))[0]!.attempts;
      expect(attempts[0]!.status).toBe("completed");
      return makeResources(input);
    });
    const decide = vi.fn<RetryController["decide"]>(async ({ operation }) => ({ shouldRetry: operation === "persistence", backoffMs: 37 }));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    let tick = 0;
    const runtime = createAutoResumingRuntime({
      harness, store, sleep,
      now: () => new Date(Date.UTC(2026, 9, 8, 0, 0, tick++)).toISOString(),
      createRetryController: () => ({ decide }),
    });
    const run = role === "subject"
      ? await runtime.submit(projectRequest("execution", `retry-${role}-${step}`))
      : await runtime.submit(projectRequest("pipeline", `retry-${role}-${step}`));
    const completed = await waitForTerminal(runtime, run.runId);
    const attempts = role === "subject"
      ? (await runtime.getSampling(run.samplingIds[0]!)).executionAttempts
      : (await runtime.getEvaluation(completed.evaluationIds[0]!)).attempts;

    expect(completed.status).toBe("succeeded");
    expect(failedRecord).toBeDefined();
    if (failure === "before") expect(retriedRecord).toEqual(failedRecord);
    const failedAttempts = "executionAttempts" in failedRecord! ? failedRecord.executionAttempts : failedRecord!.attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: "completed", resources: { status: "collected" } });
    expect(attempts[0]!.completedAt).toBe(failedAttempts[0]!.completedAt);
    expect(attempts[0]).not.toHaveProperty("error");
    if (failure === "before") {
      expect(decide).toHaveBeenCalledExactlyOnceWith({ operation: "persistence", failureKind: "network", attemptNumber: 1, error: expect.any(String) });
      expect(sleep).toHaveBeenCalledExactlyOnceWith(37);
    } else {
      expect(decide).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    }
    expect(harness.ensureAgent).toHaveBeenCalledTimes(role === "subject" ? 1 : 2);
    expect(harness.submitAgent).toHaveBeenCalledTimes(role === "subject" ? 1 : 2);
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(role === "subject" ? 1 : 2);
    expect(role === "subject" ? harness.collectExecution : harness.collectEvaluation).toHaveBeenCalledTimes(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("keeps completion when resource persistence retries are exhausted", async () => {
    const harness = makeHarness();
    const store = makeStore();
    const onError = vi.fn();
    if (role === "subject") {
      const update = store.updateSampling.bind(store);
      vi.spyOn(store, "updateSampling").mockImplementation(async (record, expected) => {
        if (record.executionAttempts.some((attempt) => attempt.resources?.status === "collected")) {
          throw new Error("resource store unavailable");
        }
        await update(record, expected);
      });
    } else {
      const update = store.updateEvaluation.bind(store);
      vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected) => {
        if (record.attempts.some((attempt) => attempt.resources?.status === "collected")) {
          throw new Error("resource store unavailable");
        }
        await update(record, expected);
      });
    }
    const runtime = createAutoResumingRuntime({
      harness, store, sleep: async () => undefined,
      onError,
      createRetryController: makeRetryControllerFactory({ persistence: 1, restart: 1 }),
    });
    const run = role === "subject"
      ? await runtime.submit(projectRequest("execution", `exhausted-${role}-persistence`))
      : await runtime.submit(projectRequest("pipeline", `exhausted-${role}-persistence`));
    if (role === "subject") await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const completed = role === "subject" ? await runtime.getRun(run.runId) : await waitForTerminal(runtime, run.runId);
    const record = role === "subject"
      ? await runtime.getSampling(run.samplingIds[0]!)
      : await runtime.getEvaluation(completed.evaluationIds[0]!);
    const attempts = "executionAttempts" in record ? record.executionAttempts : record.attempts;
    const stage = "execution" in record ? record.execution : record.status;

    if (role === "subject") {
      expect(completed.status).toBe("running");
      expect(stage.status).toBe("starting");
    } else {
      // The ended Evaluator still owes its unsaved snapshot; a later pass refreshes it read-only.
      expect(stage).toEqual({ status: "failed", lastError: "resource store unavailable", resourcesPending: { deadline: expect.any(String), nextAttemptAt: expect.any(String) } });
    }
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: "completed", completedAt: expect.any(String), resources: { status: "pending" } });
    expect(attempts[0]).not.toHaveProperty("error");
    expect(role === "subject" ? harness.collectExecution : harness.collectEvaluation).not.toHaveBeenCalled();
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(role === "subject" ? 1 : 2);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("keeps the original failed Agent facts when resource saving fails", async () => {
    const harness = makeHarness();
    const store = makeStore();
    const onError = vi.fn();
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => handle.role === role ? {
      submissionId: "submission-1",
      status: "interrupted", error: "original Agent interruption", retryable: false,
    } : makeSubmission());
    if (role === "subject") {
      const update = store.updateSampling.bind(store);
      vi.spyOn(store, "updateSampling").mockImplementation(async (record, expected) => {
        if (record.executionAttempts[0]?.resources?.status === "collected") throw new Error("resource store unavailable");
        await update(record, expected);
      });
    } else {
      const update = store.updateEvaluation.bind(store);
      vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected) => {
        if (record.attempts[0]?.resources?.status === "collected") throw new Error("resource store unavailable");
        await update(record, expected);
      });
    }
    const runtime = createAutoResumingRuntime({ harness, store, onError });
    const run = role === "subject"
      ? await runtime.submit(projectRequest("execution", `failed-${role}-resource-persistence`))
      : await runtime.submit(projectRequest("pipeline", `failed-${role}-resource-persistence`));
    if (role === "subject") await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const completed = role === "subject" ? await runtime.getRun(run.runId) : await waitForTerminal(runtime, run.runId);
    const attempts = role === "subject"
      ? (await runtime.getSampling(run.samplingIds[0]!)).executionAttempts
      : (await runtime.getEvaluation(completed.evaluationIds[0]!)).attempts;

    expect(completed.status).toBe(role === "subject" ? "running" : "failed");
    expect(attempts[0]).toMatchObject({ status: "interrupted", error: "original Agent interruption", completedAt: expect.any(String) });
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });
});

describe("pipeline cancellation isolation", () => {
  function cancellationHarness(store: RuntimeStore): Harness {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => {
      const sampling = await store.getSampling(handle.samplingId);
      return handle.role === "subject" && sampling?.projectSampleId !== "sample-a"
        ? { submissionId: "submission-1", status: "failed", retryable: false, error: "subject failed" }
        : makeSubmission();
    });
    return harness;
  }

  it.each(["before", "after"] as const)("evaluates A despite B's cancellation write failing %s commit", async (failure) => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    let firstCancellation = true;
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected) => {
      if (record.status.status === "cancelled" && firstCancellation) {
        firstCancellation = false;
        if (failure === "after") await update(record, expected);
        throw new Error("B cancellation write unavailable");
      }
      await update(record, expected);
    });
    const onError = vi.fn();
    const runtime = createAutoResumingRuntime({
      plans: makePlans([makeSample("sample-a"), makeSample("sample-b")]),
      harness, store, onError, sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ persistence: 1 }),
    });
    runtime.plans.execution = executionPlan({ executionConcurrency: 3 });
    runtime.plans.evaluation = evaluationPlan({ evaluationConcurrency: 2 });
    const run = await runtime.submit(projectRequest("pipeline", `cancel-${failure}`, ["sample-a", "sample-b"]));
    const completed = await waitForTerminal(runtime, run.runId);
    const [evaluationA] = await runtime.listEvaluations(run.samplingIds[0]!);
    await expect.poll(async () => (await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("cancelled");
    const [evaluationB] = await runtime.listEvaluations(run.samplingIds[1]!);

    expect(completed.status).toBe("failed");
    expect(evaluationA!.status).toEqual({ status: "succeeded" });
    expect(evaluationA!.attempts).toHaveLength(1);
    expect(evaluationB!.status).toEqual({ status: "cancelled", lastError: "execution did not succeed" });
    expect(evaluationB!.attempts).toHaveLength(0);
    expect(vi.mocked(harness.ensureAgent).mock.calls.filter(([input]) => input.role === "evaluator")).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not make A wait for B's cancellation retry", async () => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    let firstCancellation = true;
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected) => {
      if (record.status.status === "cancelled" && firstCancellation) {
        firstCancellation = false;
        throw new Error("B cancellation write unavailable");
      }
      await update(record, expected);
    });
    let releaseRetry!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const sleep = vi.fn(async () => gate);
    const runtime = createAutoResumingRuntime({
      plans: makePlans([makeSample("sample-a"), makeSample("sample-b")]), harness, store, sleep,
      createRetryController: makeRetryControllerFactory({ persistence: 1 }),
    });
    runtime.plans.execution = executionPlan({ executionConcurrency: 3 });
    runtime.plans.evaluation = evaluationPlan({ evaluationConcurrency: 2 });
    const run = await runtime.submit(projectRequest("pipeline", "cancel-retry-gate", ["sample-a", "sample-b"]));
    try {
      await expect.poll(async () => (await runtime.listEvaluations(run.samplingIds[0]!))[0]!.status.status).toBe("succeeded");
      expect(sleep).toHaveBeenCalledTimes(1);
      expect((await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("queued");
    } finally {
      releaseRetry();
    }
    await expect.poll(async () => (await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("cancelled");
  });

  it.each([true, false])("records cancellation failure only on B (retryable: %s)", async (retryable) => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected) => {
      if (record.status.status === "cancelled") {
        throw Object.assign(new Error("B cancellation unavailable"), { retryable });
      }
      await update(record, expected);
    });
    const onError = vi.fn();
    const runtime = createAutoResumingRuntime({
      plans: makePlans([makeSample("sample-a"), makeSample("sample-b")]), harness, store, onError,
      sleep: async () => undefined, createRetryController: makeRetryControllerFactory({ persistence: 1 }),
    });
    runtime.plans.execution = executionPlan({ executionConcurrency: 3 });
    runtime.plans.evaluation = evaluationPlan({ evaluationConcurrency: 2 });
    const run = await runtime.submit(projectRequest("pipeline", `cancel-exhausted-${retryable}`, ["sample-a", "sample-b"]));
    await waitForTerminal(runtime, run.runId);
    await expect.poll(async () => (await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("failed");
    const [evaluationA] = await runtime.listEvaluations(run.samplingIds[0]!);
    const [evaluationB] = await runtime.listEvaluations(run.samplingIds[1]!);

    expect(evaluationA!.status).toEqual({ status: "succeeded" });
    expect(evaluationA!.attempts).toHaveLength(1);
    expect(evaluationB!.status).toEqual({ status: "failed", lastError: "evaluation cancellation persistence failed: B cancellation unavailable" });
    expect(evaluationB!.attempts).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports B's error when neither cancellation nor its error record can be saved", async () => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected) => {
      if (record.status.status === "cancelled" || record.status.lastError?.startsWith("evaluation cancellation persistence failed:")) {
        throw new Error("B storage unavailable");
      }
      await update(record, expected);
    });
    const onError = vi.fn();
    const runtime = createAutoResumingRuntime({
      plans: makePlans([makeSample("sample-a"), makeSample("sample-b")]), harness, store, onError,
    });
    runtime.plans.execution = executionPlan({ executionConcurrency: 3 });
    runtime.plans.evaluation = evaluationPlan({ evaluationConcurrency: 2 });
    const run = await runtime.submit(projectRequest("pipeline", "cancel-report", ["sample-a", "sample-b"]));
    await waitForTerminal(runtime, run.runId);
    await expect.poll(() => onError.mock.calls.length).toBe(1);
    const [evaluationA] = await runtime.listEvaluations(run.samplingIds[0]!);
    const [evaluationB] = await runtime.listEvaluations(run.samplingIds[1]!);
    const reported = onError.mock.calls[0]![0] as AggregateError;

    expect(evaluationA!.status).toEqual({ status: "succeeded" });
    expect(evaluationA!.attempts).toHaveLength(1);
    expect(evaluationB!.status.status).toBe("queued");
    expect(evaluationB!.attempts).toHaveLength(0);
    expect(reported).toBeInstanceOf(AggregateError);
    expect(reported.message).toContain(evaluationB!.evaluationId);
    expect(reported.message).toContain(evaluationB!.samplingId);
    expect(reported.errors).toHaveLength(2);
  });

  it("does not downgrade committed cancellation when reconciliation temporarily fails", async () => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    const read = store.getEvaluation.bind(store);
    let uncertainEvaluationId: string | undefined;
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected) => {
      await update(record, expected);
      if (record.status.status === "cancelled" && !uncertainEvaluationId) {
        uncertainEvaluationId = record.evaluationId;
        throw new Error("cancellation response lost");
      }
    });
    let firstRead = true;
    vi.spyOn(store, "getEvaluation").mockImplementation(async (evaluationId) => {
      if (evaluationId === uncertainEvaluationId && firstRead) {
        firstRead = false;
        throw new Error("reconciliation unavailable");
      }
      return read(evaluationId);
    });
    const onError = vi.fn();
    const runtime = createAutoResumingRuntime({
      plans: makePlans([makeSample("sample-a"), makeSample("sample-b")]), harness, store, onError,
    });
    runtime.plans.execution = executionPlan({ executionConcurrency: 3 });
    runtime.plans.evaluation = evaluationPlan({ evaluationConcurrency: 2 });
    const run = await runtime.submit(projectRequest("pipeline", "cancel-read-failed", ["sample-a", "sample-b"]));
    await waitForTerminal(runtime, run.runId);
    expect((await runtime.listEvaluations(run.samplingIds[0]!))[0]!.status.status).toBe("succeeded");
    expect((await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("cancelled");
    expect(onError).not.toHaveBeenCalled();
    expect(vi.mocked(store.updateEvaluation).mock.calls.some(([record]) => record.status.status === "failed")).toBe(false);
  });

  it("isolates failed cancellation records even when no sampling is evaluable", async () => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected) => {
      const sampling = await store.getSampling(record.samplingId);
      if (record.status.status === "cancelled" && sampling!.projectSampleId === "sample-b") {
        throw new Error("B cancellation unavailable");
      }
      await update(record, expected);
    });
    const runtime = createAutoResumingRuntime({
      plans: makePlans([makeSample("sample-b"), makeSample("sample-c")]), harness, store,
    });
    runtime.plans.execution = executionPlan({ executionConcurrency: 3 });
    runtime.plans.evaluation = evaluationPlan({ evaluationConcurrency: 2 });
    const run = await runtime.submit(projectRequest("pipeline", "all-executions-failed", ["sample-b", "sample-c"]));
    await waitForTerminal(runtime, run.runId);
    await expect.poll(async () => (await runtime.listEvaluations(run.samplingIds[0]!))[0]!.status.status).toBe("failed");
    await expect.poll(async () => (await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("cancelled");
    expect((await runtime.listEvaluations(run.samplingIds[0]!))[0]!.status.lastError).toContain("B cancellation unavailable");
    expect(vi.mocked(harness.ensureAgent).mock.calls.every(([input]) => input.role === "subject")).toBe(true);
    expect(harness.collectEvaluation).not.toHaveBeenCalled();
  });

  it.each(["default", "throwing"] as const)("keeps A independent when using the %s error reporter", async (reporter) => {
    const store = makeStore();
    const harness = cancellationHarness(store);
    const update = store.updateEvaluation.bind(store);
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected) => {
      if (record.status.status === "cancelled" || record.status.lastError?.startsWith("evaluation cancellation persistence failed:")) {
        throw new Error("B storage unavailable");
      }
      await update(record, expected);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const runtime = createAutoResumingRuntime({
        plans: makePlans([makeSample("sample-a"), makeSample("sample-b")]), harness, store,
        ...(reporter === "throwing" ? { onError: () => { throw new Error("reporter unavailable"); } } : {}),
      });
      runtime.plans.execution = executionPlan({ executionConcurrency: 3 });
      runtime.plans.evaluation = evaluationPlan({ evaluationConcurrency: 2 });
      const run = await runtime.submit(projectRequest("pipeline", `cancel-reporter-${reporter}`, ["sample-a", "sample-b"]));
      await waitForTerminal(runtime, run.runId);
      await expect.poll(() => logged.mock.calls.length).toBe(1);
      expect((await runtime.listEvaluations(run.samplingIds[0]!))[0]!.status.status).toBe("succeeded");
      expect((await runtime.listEvaluations(run.samplingIds[1]!))[0]!.status.status).toBe("queued");
    } finally {
      logged.mockRestore();
    }
  });
});

describe("SP Chat and Submission identities", () => {
  it("does not create a replacement Chat when recovering an Attempt without its Chat ID", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const runtime = createRuntime({
      harness, store,
    });
    const run = await runtime.submit(projectRequest("execution", "missing-chat-on-recovery"));
    const samplingId = run.samplingIds[0]!;
    const original = await saved(store, samplingId);
    await store.updateSampling({
      ...original,
      execution: { status: "running" },
      executionAttempts: [{
        executionAttemptId: "existing-attempt", samplingId, attemptNumber: 1,
        status: "running", startedAt: "2026-10-09T00:00:00.000Z",
      }],
    }, original);

    await runtime.resume(run.runId);

    expect((await runtime.getSampling(samplingId)).execution.status).toBe("failed");
    expect(harness.ensureAgent).not.toHaveBeenCalled();
    expect(harness.submitAgent).not.toHaveBeenCalled();
  });

  it("keeps one Chat/Session while each restart receives a new Submission ID", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValueOnce({
      ...makeSubmission("failed", "turn-1"),
      retryable: true,
      failureKind: "llm",
      error: "temporary model failure",
    });
    vi.mocked(harness.restartAgent).mockResolvedValueOnce(makeSubmission("completed", "turn-2"));
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
    const runtime = createAutoResumingRuntime({
      harness,
      store: makeStore(),
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ restart: 1 }),
    });

    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await runtime.submit(projectRequest("execution", "separate-chat-and-submissions"));
    expect((await waitForTerminal(runtime, run.runId)).status).toBe("succeeded");

    const sampling = await runtime.getSampling(run.samplingIds[0]!);
    expect(sampling.subjectChatId).toEqual(expect.any(String));
    expect(sampling.executionAttempts.map((attempt) => attempt.submissionId)).toEqual(["turn-1", "turn-2"]);
    expect(sampling.subjectChatId).not.toBe("turn-1");
    expect(sampling.subjectChatId).not.toBe("turn-2");
    expect(sampling.executionAttempts.map((attempt) => (
      attempt.resources?.status === "collected" ? attempt.resources.summary.scope : undefined
    ))).toEqual([
      { chatId: sampling.subjectChatId, submissionId: "turn-1", idempotencyKey: `execution:${sampling.samplingId}` },
      { chatId: sampling.subjectChatId, submissionId: "turn-2", idempotencyKey: `execution:${sampling.samplingId}:restart:2` },
    ]);
    expect(harness.ensureAgent).toHaveBeenCalledOnce();
    expect(harness.restartAgent).toHaveBeenCalledOnce();
  });
});

describe("Run recovery from persisted facts", () => {
  function dormantRuntime(store: TestStore, harness: Harness) {
    return createRuntime({ harness, store, sleep: async () => undefined });
  }

  it("resumes a persisted Run with only the plan reader, Store and Harness", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const admitted = dormantRuntime(store, harness);
    const run = await admitted.submit(projectRequest("execution", "narrow-run-resumer"));
    const resumer = createTestResumer(store, harness);
    expect("start" in resumer).toBe(false);
    expect("submit" in resumer).toBe(false);
    expect("listProjects" in resumer).toBe(false);

    await resumer.resume(run.runId);

    expect((await store.getSampling(run.samplingIds[0]!))?.execution.status).toBe("succeeded");
    expect(harness.submitAgent).toHaveBeenCalledOnce();
  });

  it("collects failed Subject evidence after a crash without resubmitting its terminal Submission", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const admitted = dormantRuntime(store, harness);
    const run = await admitted.submit(projectRequest("execution", "failed-evidence-crash-gap"));
    const samplingId = run.samplingIds[0]!;
    const chatId = "subject-after-crash";
    const handle: AgentHandle = { ownerUserId: SUBJECT.ownerUserId, chatId, samplingId, role: "subject", framework: "sp" };
    const idempotencyKey = `execution:${samplingId}`;
    const original = await saved(store, samplingId);
    await store.updateSampling({
      ...original,
      subjectChatId: chatId,
      execution: { status: "starting" },
      executionAttempts: [{
        executionAttemptId: "failed-before-crash", samplingId, attemptNumber: 1,
        submissionId: "submission-1", status: "failed", error: "agent task failed",
        completedAt: "2026-10-14T00:00:00.000Z",
        resources: { status: "collected", summary: summarizeResourceSnapshot(makeResources({ handle, idempotencyKey })) },
      }],
    }, original);
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue({
      submissionId: "submission-1", status: "failed",
      error: "agent task failed", retryable: false,
    });
    vi.mocked(harness.collectExecution).mockResolvedValue({
      samplingId, status: "failed",
      artifacts: [{ artifactId: "partial", kind: "project", path: "/eval/partial" }],
      trajectory: { trajectoryId: "complete-trace", source: "subject", path: "/eval/trace.jsonl" },
    });

    await createTestResumer(store, harness).resume(run.runId);

    expect((await store.getSampling(samplingId))?.execution).toEqual({ status: "failed", lastError: "agent task failed" });
    expect((await store.getSampling(samplingId))?.trajectory?.trajectoryId).toBe("complete-trace");
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it.each((["subject", "evaluator"] as const).flatMap((role) => (
    (["terminal", "resources"] as const).map((step) => ({ role, step }))
  )))("keeps observed $role $step facts when saving never commits", async ({ role, step }) => {
    const store = makeStore();
    const harness = makeHarness();
    let rejected = 0;
    const isTarget = (record: SamplingState | EvaluationRecord) => {
      const attempt = "executionAttempts" in record ? record.executionAttempts[0] : record.attempts[0];
      return attempt?.status === "completed" && attempt.resources?.status === (
        step === "terminal" ? "pending" : "collected"
      );
    };
    if (role === "subject") {
      const write = store.updateSampling.bind(store);
      vi.spyOn(store, "updateSampling").mockImplementation(async (record, expected) => {
        if (isTarget(record) && rejected++ < 2) throw new Error("save unavailable");
        await write(record, expected);
      });
    } else {
      const write = store.updateEvaluation.bind(store);
      vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected) => {
        if (isTarget(record) && rejected++ < 2) throw new Error("save unavailable");
        await write(record, expected);
      });
    }
    const runtime = createRuntime({
      harness, store,
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ persistence: 1 }),
    });
    const run = role === "subject"
      ? await runtime.submit(projectRequest("execution", "uncommitted-subject-" + step))
      : await runtime.submit(projectRequest("pipeline", "uncommitted-evaluator-" + step));
    if (role === "subject") {
      await expect(runtime.resume(run.runId)).rejects.toThrow("Execution phase could not persist its progress");
    } else {
      await runtime.resume(run.runId);
    }
    const snapshot = await runtime.getRun(run.runId);
    const record = role === "subject"
      ? await store.getSampling(run.samplingIds[0]!)
      : await store.getEvaluation(snapshot.evaluationIds[0]!);
    const attempt = record && "executionAttempts" in record ? record.executionAttempts[0] : record?.attempts[0];
    expect(snapshot.status).toBe(role === "subject" ? "running" : "failed");
    expect(attempt).toMatchObject(role === "subject" && step === "terminal"
      ? { status: "running", resources: { status: "pending" } }
      : { status: "completed", completedAt: expect.any(String), resources: { status: "pending" } });
    await runtime.resume(run.runId);
    expect(harness.submitAgent).toHaveBeenCalledTimes(role === "subject" ? 1 : 2);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it.each((["subject", "evaluator"] as const).flatMap((role) => (
    (["terminal", "resources"] as const).map((step) => ({ role, step }))
  )))("preserves committed $role $step facts when save and read responses are lost", async ({ role, step }) => {
    const store = makeStore();
    const harness = makeHarness();
    let lost = 0;
    let unreadable = 0;
    const isTarget = (record: SamplingState | EvaluationRecord) => {
      const attempt = "executionAttempts" in record ? record.executionAttempts[0] : record.attempts[0];
      return attempt?.status === "completed" && attempt.resources?.status === (
        step === "terminal" ? "pending" : "collected"
      );
    };
    if (role === "subject") {
      const write = store.updateSampling.bind(store);
      vi.spyOn(store, "updateSampling").mockImplementation(async (record, expected) => {
        await write(record, expected);
        if (isTarget(record) && lost++ < 2) throw new Error("save response lost");
      });
      const read = store.getSampling.bind(store);
      vi.spyOn(store, "getSampling").mockImplementation(async (id) => {
        if (lost > 0 && unreadable++ < 2) throw new Error("read temporarily unavailable");
        return read(id);
      });
    } else {
      const write = store.updateEvaluation.bind(store);
      vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected) => {
        await write(record, expected);
        if (isTarget(record) && lost++ < 2) throw new Error("save response lost");
      });
      const read = store.getEvaluation.bind(store);
      vi.spyOn(store, "getEvaluation").mockImplementation(async (id) => {
        if (lost > 0 && unreadable++ < 2) throw new Error("read temporarily unavailable");
        return read(id);
      });
    }
    const runtime = createRuntime({
      harness, store,
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ persistence: 1 }),
    });
    const run = role === "subject"
      ? await runtime.submit(projectRequest("execution", "uncertain-subject-" + step))
      : await runtime.submit(projectRequest("pipeline", "uncertain-evaluator-" + step));
    await expect(runtime.resume(run.runId)).rejects.toThrow(
      role === "subject" ? "Execution phase could not persist its progress" : "Evaluation phase could not persist its progress",
    );
    const record = role === "subject"
      ? await store.getSampling(run.samplingIds[0]!)
      : await store.getEvaluation((await runtime.getRun(run.runId)).evaluationIds[0]!);
    const attempt = record && "executionAttempts" in record ? record.executionAttempts[0] : record?.attempts[0];
    expect(attempt).toMatchObject({
      status: "completed", completedAt: expect.any(String),
      resources: { status: step === "terminal" ? "pending" : "collected" },
    });
    const stage = record && "execution" in record ? record.execution.status : record?.status.status;
    expect(stage).not.toBe("failed");
    await runtime.resume(run.runId);
    expect((await runtime.getRun(run.runId)).status).toBe("succeeded");
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.submitAgent).toHaveBeenCalledTimes(role === "subject" ? 1 : 2);
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(role === "subject" ? 1 : 2);
  });

  it("keeps a partial resource snapshot and gives it up when its recovery download spends the retry budget", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const reported = vi.fn();
    const runtime = createRuntime({
      harness, store,
      sleep: async () => undefined, onError: reported,
    });
    const run = await runtime.submit(projectRequest("execution", "partial-resource-refresh-fails"));
    const samplingId = run.samplingIds[0]!;
    const chatId = "subject-chat";
    const submissionId = "submission-1";
    const idempotencyKey = "execution:" + samplingId;
    const handle: AgentHandle = { ownerUserId: SUBJECT.ownerUserId, role: "subject", framework: "sp", samplingId, chatId };
    const snapshot = {
      ...makeResources({ handle, idempotencyKey }),
      finalized: false,
      coverage: { usageEvents: "partial" as const, nativeRecords: "partial" as const, billingSettlements: "partial" as const },
    };
    await seedSampling(store, {
      ...(await saved(store, samplingId)),
      subjectChatId: chatId,
      execution: { status: "retrying" },
      executionAttempts: [{
        executionAttemptId: "attempt-before-recovery", samplingId, attemptNumber: 1,
        submissionId, status: "running", startedAt: "2026-10-09T00:00:00.000Z",
        resources: { status: "collected", summary: summarizeResourceSnapshot(snapshot) },
      }],
    });
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue(makeSubmission());
    vi.mocked(harness.collectAgentResources).mockRejectedValue(new Error("refresh unavailable"));
    await runtime.resume(run.runId);
    const persisted = await saved(store, samplingId);
    expect(persisted.execution).toEqual({ status: "succeeded" });
    expect(persisted.executionAttempts[0]!.resources).toEqual({
      status: "collected", summary: summarizeResourceSnapshot(snapshot), downloads: 1, exhausted: true,
    });
    await expect(runtime.getRun(run.runId)).resolves.toMatchObject({ status: "succeeded" });
    expect(reported).toHaveBeenCalledOnce();
    await runtime.resume(run.runId);
    expect(reported).toHaveBeenCalledOnce();
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.collectAgentResources).toHaveBeenCalledOnce();
  });

  it("keeps an evaluator resource snapshot and gives it up when its recovery download spends the retry budget", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const reported = vi.fn();
    const runtime = createRuntime({
      harness, store,
      sleep: async () => undefined, onError: reported,
    });
    const run = await runtime.submit(projectRequest("pipeline", "evaluator-resource-refresh-fails"));
    const samplingId = run.samplingIds[0]!;
    await seedSampling(store, {
      ...(await saved(store, samplingId)),
      subjectChatId: "subject-chat",
      execution: { status: "succeeded" },
      artifacts: [{ artifactId: "subject-artifact", kind: "project", path: "/output" }],
      trajectory: { trajectoryId: "subject-trajectory", source: "subject", path: "/trajectory" },
    });
    const evaluation = (await store.listEvaluations(samplingId))[0]!;
    const chatId = "evaluator-chat";
    const submissionId = "submission-1";
    const idempotencyKey = "evaluation:" + samplingId;
    const handle: AgentHandle = { ownerUserId: EVALUATOR.ownerUserId, role: "evaluator", framework: "sp", samplingId, chatId };
    const snapshot = {
      ...makeResources({ handle, idempotencyKey }),
      finalized: false,
      coverage: { usageEvents: "partial" as const, nativeRecords: "partial" as const, billingSettlements: "partial" as const },
    };
    await seedEvaluation(store, {
      ...evaluation, chatId, status: { status: "retrying" },
      attempts: [{
        evaluationAttemptId: "judge-before-recovery", evaluationId: evaluation.evaluationId,
        attemptNumber: 1, submissionId, status: "running",
        startedAt: "2026-10-09T00:00:00.000Z",
        resources: { status: "collected", summary: summarizeResourceSnapshot(snapshot) },
      }],
    });
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue(makeSubmission());
    vi.mocked(harness.collectAgentResources).mockRejectedValue(new Error("evaluator refresh unavailable"));
    await runtime.resume(run.runId);
    const persisted = await savedEvaluation(store, evaluation.evaluationId);
    expect(persisted.status).toEqual({ status: "succeeded" });
    expect(persisted.attempts[0]!.resources).toEqual({
      status: "collected", summary: summarizeResourceSnapshot(snapshot), downloads: 1, exhausted: true,
    });
    expect(reported).toHaveBeenCalledOnce();
    await runtime.resume(run.runId);
    expect(reported).toHaveBeenCalledOnce();
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.collectAgentResources).toHaveBeenCalledOnce();
  });

  it("does not refresh a finalized resource snapshot during recovery", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const reported = vi.fn();
    const runtime = createRuntime({
      harness, store,
      sleep: async () => undefined, onError: reported,
    });
    const run = await runtime.submit(projectRequest("execution", "finalized-resource-recovery"));
    const samplingId = run.samplingIds[0]!;
    const chatId = "subject-chat";
    const submissionId = "submission-1";
    const idempotencyKey = "execution:" + samplingId;
    const handle: AgentHandle = { ownerUserId: SUBJECT.ownerUserId, role: "subject", framework: "sp", samplingId, chatId };
    const snapshot = makeResources({ handle, idempotencyKey });
    await seedSampling(store, {
      ...(await saved(store, samplingId)),
      subjectChatId: chatId,
      execution: { status: "retrying" },
      executionAttempts: [{
        executionAttemptId: "finalized-before-recovery", samplingId, attemptNumber: 1,
        submissionId, status: "running", startedAt: "2026-10-09T00:00:00.000Z",
        resources: { status: "collected", summary: summarizeResourceSnapshot(snapshot) },
      }],
    });
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue(makeSubmission());
    vi.mocked(harness.collectAgentResources).mockRejectedValue(new Error("should not refresh"));
    await runtime.resume(run.runId);
    const persisted = await saved(store, samplingId);
    expect(persisted.execution.status).toBe("succeeded");
    expect(persisted.executionAttempts[0]!.resources).toEqual({ status: "collected", summary: summarizeResourceSnapshot(snapshot) });
    expect(harness.collectAgentResources).not.toHaveBeenCalled();
    expect(reported).not.toHaveBeenCalled();
  });

  it("admits a queued Run without executing and resumes it from the Project plan", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const original = dormantRuntime(store, harness);
    const run = await original.submit(projectRequest("execution", "admitted-only"));

    expect((await original.getRun(run.runId)).status).toBe("queued");
    expect(harness.ensureAgent).not.toHaveBeenCalled();

    const recovered = dormantRuntime(store, harness);
    await recovered.resume(run.runId);

    expect((await recovered.getRun(run.runId)).status).toBe("succeeded");
    expect(harness.submitAgent).toHaveBeenCalledOnce();
    await recovered.resume(run.runId);
    expect(harness.submitAgent).toHaveBeenCalledOnce();
  });

  it("reconciles a submitted Attempt by its original key instead of submitting again", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const run = await dormantRuntime(store, harness).submit(projectRequest("execution", "submitted-before-crash"));
    const samplingId = run.samplingIds[0]!;
    const record = await saved(store, samplingId);
    const chatId = "subject-chat";
    const submissionId = "submission-1";
    const idempotencyKey = `execution:${samplingId}`;
    await seedSampling(store, {
      ...record,
      subjectChatId: chatId,
      execution: { status: "running" },
      executionAttempts: [{
        executionAttemptId: "attempt-before-crash", samplingId, attemptNumber: 1,
        submissionId, status: "running", startedAt: "2026-10-09T00:00:00.000Z",
        resources: { status: "pending", scope: { chatId, submissionId, idempotencyKey } },
      }],
    });
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue(makeSubmission());

    await dormantRuntime(store, harness).resume(run.runId);

    expect(harness.inspectAgentOperation).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey }));
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.collectExecution).toHaveBeenCalledOnce();
    const persisted = await saved(store, samplingId);
    expect(persisted.execution.status).toBe("succeeded");
    expect(persisted.executionAttempts).toHaveLength(1);
    expect(persisted.executionAttempts[0]!.executionAttemptId).toBe("attempt-before-crash");
  });

  it("rejects a recovered Attempt bound to a different submission without changing its identity", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const run = await dormantRuntime(store, harness).submit(projectRequest("execution", "conflicting-attempt-identity"));
    const samplingId = run.samplingIds[0]!;
    await seedSampling(store, {
      ...(await saved(store, samplingId)),
      subjectChatId: "correct-chat",
      execution: { status: "running" },
      executionAttempts: [{
        executionAttemptId: "conflicting-attempt", samplingId, attemptNumber: 1,
        submissionId: "another-submission", status: "running",
        startedAt: "2026-10-09T00:00:00.000Z",
      }],
    });
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue(makeSubmission());

    await dormantRuntime(store, harness).resume(run.runId);

    const stored = await saved(store, samplingId);
    expect(stored.execution.status).toBe("failed");
    expect(stored.executionAttempts[0]!.submissionId).toBe("another-submission");
    expect(harness.ensureAgent).toHaveBeenCalledOnce();
    expect(harness.submitAgent).not.toHaveBeenCalled();
  });

  it("refreshes resources collected before the terminal state was confirmed", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const run = await dormantRuntime(store, harness).submit(projectRequest("execution", "uncertain-before-crash"));
    const samplingId = run.samplingIds[0]!;
    const chatId = "subject-chat";
    const submissionId = "submission-1";
    const idempotencyKey = `execution:${samplingId}`;
    const handle: AgentHandle = { ownerUserId: SUBJECT.ownerUserId, role: "subject", framework: "sp", samplingId, chatId };
    await seedSampling(store, {
      ...(await saved(store, samplingId)),
      subjectChatId: chatId,
      execution: { status: "retrying" },
      executionAttempts: [{
        executionAttemptId: "uncertain-attempt", samplingId, attemptNumber: 1,
        submissionId, status: "running", startedAt: "2026-10-09T00:00:00.000Z",
        resources: { status: "collected", summary: summarizeResourceSnapshot({ ...makeResources({ handle, idempotencyKey }), finalized: false }) },
      }],
    });
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue(makeSubmission());
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => ({
      ...makeResources(input), usageEvents: [{ eventId: "terminal-usage" }],
    }));

    await dormantRuntime(store, harness).resume(run.runId);

    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.collectAgentResources).toHaveBeenCalledOnce();
    const resources = (await saved(store, samplingId)).executionAttempts[0]!.resources;
    expect(resources).toMatchObject({ status: "collected", summary: { counts: { usageEvents: 1 } } });
    expect(store.resourceSnapshot({ samplingId, attemptId: "uncertain-attempt" })).toMatchObject({ usageEvents: [{ eventId: "terminal-usage" }] });
  });

  it("repairs a completed Agent's resource save from another Runtime without rerunning the Agent", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const originalWrite = store.updateSampling.bind(store);
    let unavailable = true;
    vi.spyOn(store, "updateSampling").mockImplementation(async (record, expected) => {
      if (unavailable && (record.executionAttempts[0]?.resources?.status === "collected"
        || record.execution.status === "failed")) {
        throw new Error("resource store unavailable");
      }
      await originalWrite(record, expected);
    });
    const original = dormantRuntime(store, harness);
    const run = await original.submit(projectRequest("execution", "resource-save-before-crash"));
    await expect(original.resume(run.runId)).rejects.toThrow("Execution phase could not persist its progress");

    const before = await saved(store, run.samplingIds[0]!);
    expect(before.execution.status).toBe("starting");
    expect(before.executionAttempts[0]).toMatchObject({ status: "completed", resources: { status: "pending" } });
    unavailable = false;
    await dormantRuntime(store, harness).resume(run.runId);

    const after = await saved(store, run.samplingIds[0]!);
    expect(after.execution.status).toBe("succeeded");
    expect(after.executionAttempts[0]!.executionAttemptId).toBe(before.executionAttempts[0]!.executionAttemptId);
    expect(after.executionAttempts[0]!.completedAt).toBe(before.executionAttempts[0]!.completedAt);
    expect(harness.submitAgent).toHaveBeenCalledOnce();
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.collectExecution).toHaveBeenCalledOnce();
  });

  it("restarts after a persisted failure only when SP confirms that same operation", async () => {
    const store = makeStore();
    const harness = makeHarness();
    store.plans().execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await dormantRuntime(store, harness).submit(projectRequest("execution", "resume-restart"));
    const samplingId = run.samplingIds[0]!;
    const chatId = "subject-chat";
    const submissionId = "submission-1";
    const idempotencyKey = `execution:${samplingId}`;
    const handle: AgentHandle = { ownerUserId: SUBJECT.ownerUserId, role: "subject", framework: "sp", samplingId, chatId };
    await seedSampling(store, {
      ...(await saved(store, samplingId)),
      subjectChatId: chatId,
      execution: { status: "retrying" },
      executionAttempts: [{
        executionAttemptId: "failed-attempt", samplingId, attemptNumber: 1, submissionId,
        status: "failed", error: "upstream failed", completedAt: "2026-10-09T00:00:00.000Z",
        resources: { status: "collected", summary: summarizeResourceSnapshot(makeResources({ handle, idempotencyKey })) },
      }],
    });
    vi.mocked(harness.inspectAgentOperation).mockResolvedValueOnce(null).mockResolvedValueOnce({
      submissionId,
      status: "failed", retryable: true,
      failureKind: "llm", error: "upstream failed",
    });

    await createRuntime({
      harness, store,
      sleep: async () => undefined,
      createRetryController: makeRetryControllerFactory({ status: 1, restart: 1 }),
    }).resume(run.runId);

    expect(vi.mocked(harness.inspectAgentOperation).mock.calls.map(([input]) => input.idempotencyKey))
      .toEqual([idempotencyKey, idempotencyKey]);
    expect(harness.restartAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      idempotencyKey: `execution:${samplingId}:restart:2`,
    }));
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect((await saved(store, samplingId)).executionAttempts).toHaveLength(2);
  });

  it("keeps a persisted retryable failure pending through one SP status outage, then restarts it", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const runtime = dormantRuntime(store, harness);
    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await runtime.submit(projectRequest("execution", "retry-after-status-outage"));
    const samplingId = run.samplingIds[0]!;
    const chatId = "subject-chat";
    const submissionId = "submission-1";
    const idempotencyKey = `execution:${samplingId}`;
    const handle: AgentHandle = { ownerUserId: SUBJECT.ownerUserId, role: "subject", framework: "sp", samplingId, chatId };
    await seedSampling(store, {
      ...(await saved(store, samplingId)),
      subjectChatId: chatId,
      execution: { status: "retrying" },
      executionAttempts: [{
        executionAttemptId: "failed-before-recovery", samplingId, attemptNumber: 1, submissionId,
        status: "failed", error: "upstream failed", completedAt: "2026-10-09T00:00:00.000Z",
        resources: { status: "collected", summary: summarizeResourceSnapshot(makeResources({ handle, idempotencyKey })) },
      }],
    });
    vi.mocked(harness.inspectAgentOperation)
      .mockRejectedValueOnce(new Error("temporary SP 503"))
      .mockResolvedValueOnce({
        submissionId, status: "failed",
        retryable: true, failureKind: "llm", error: "upstream failed",
      });

    await expect(runtime.resume(run.runId)).rejects.toThrow("Execution phase could not persist its progress");
    const pending = await saved(store, samplingId);
    expect(pending.execution).toEqual({ status: "retrying" });
    expect(harness.collectExecution).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();

    await runtime.resume(run.runId);
    expect((await runtime.getRun(run.runId)).status).toBe("succeeded");
    expect(harness.restartAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      idempotencyKey: `execution:${samplingId}:restart:2`,
    }));
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect((await saved(store, samplingId)).executionAttempts).toHaveLength(2);
  });

  it("does not restart a persisted failure when its operation cannot be confirmed", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const runtime = dormantRuntime(store, harness);
    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_ONE });
    const run = await runtime.submit(projectRequest("execution", "unconfirmed-restart"));
    const samplingId = run.samplingIds[0]!;
    const chatId = "subject-chat";
    const submissionId = "submission-1";
    const handle: AgentHandle = { ownerUserId: SUBJECT.ownerUserId, role: "subject", framework: "sp", samplingId, chatId };
    await seedSampling(store, {
      ...(await saved(store, samplingId)),
      subjectChatId: chatId,
      execution: { status: "retrying" },
      executionAttempts: [{
        executionAttemptId: "unconfirmed-attempt", samplingId, attemptNumber: 1, submissionId,
        status: "failed", error: "upstream failed", completedAt: "2026-10-09T00:00:00.000Z",
        resources: { status: "collected", summary: summarizeResourceSnapshot(makeResources({ handle, idempotencyKey: `execution:${samplingId}` })) },
      }],
    });
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue(null);

    await expect(runtime.resume(run.runId)).rejects.toThrow("Execution phase could not persist its progress");
    await expect(runtime.resume(run.runId)).rejects.toThrow("Execution phase could not persist its progress");

    expect((await runtime.getRun(run.runId)).status).toBe("retrying");
    expect(harness.inspectAgentOperation).toHaveBeenCalledTimes(2);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.collectExecution).not.toHaveBeenCalled();
    expect((await saved(store, samplingId)).executionAttempts).toHaveLength(1);
  });

  it("resumes a pipeline at evaluation without launching its completed Subject again", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const run = await dormantRuntime(store, harness).submit(projectRequest("pipeline", "pipeline-handoff"));
    const samplingId = run.samplingIds[0]!;
    await seedSampling(store, {
      ...(await saved(store, samplingId)),
      subjectChatId: "completed-subject",
      execution: { status: "succeeded" },
      artifacts: [{ artifactId: "artifact-1", kind: "project", path: "/output" }],
      trajectory: { trajectoryId: "subject-trajectory", source: "subject", path: "/trajectory" },
    });

    const recovered = dormantRuntime(store, harness);
    await recovered.resume(run.runId);

    expect((await recovered.getRun(run.runId)).status).toBe("succeeded");
    expect(harness.ensureAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ role: "evaluator" }));
    expect(harness.submitAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      handle: expect.objectContaining({ role: "evaluator" }),
    }));
  });

  it("finalizes an existing Evaluation Attempt without submitting its Agent again", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const original = dormantRuntime(store, harness);
    const execution = await original.submit(projectRequest("execution", "execution-before-evaluation-recovery"));
    await original.resume(execution.runId);
    const run = await original.submit(evaluationRequest(execution.samplingIds));
    const evaluationId = (await store.getRun(run.runId))!.evaluationIds[0]!;
    const evaluation = await savedEvaluation(store, evaluationId);
    const chatId = "evaluator-chat";
    const submissionId = "submission-1";
    const idempotencyKey = `evaluation:${evaluation.samplingId}`;
    await seedEvaluation(store, {
      ...evaluation,
      chatId,
      status: { status: "running" },
      attempts: [{
        evaluationAttemptId: "existing-evaluation-attempt", evaluationId: evaluation.evaluationId,
        attemptNumber: 1, submissionId, status: "completed", completedAt: "2026-10-09T00:00:00.000Z",
        resources: { status: "pending", scope: { chatId, submissionId, idempotencyKey } },
      }],
    });
    vi.mocked(harness.submitAgent).mockClear();

    const recovered = dormantRuntime(store, harness);
    await recovered.resume(run.runId);

    expect((await recovered.getRun(run.runId)).status).toBe("succeeded");
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.collectEvaluation).toHaveBeenCalledOnce();
    expect((await savedEvaluation(store, evaluation.evaluationId)).attempts[0]!.evaluationAttemptId)
      .toBe("existing-evaluation-attempt");
  });
});

it("recollects completed Subject and Evaluator results without dispatching or importing anything", async () => {
  const harness = makeHarness();
  const store = makeStore();
  const runtime = createAutoResumingRuntime({ harness, store, sleep: async () => undefined });
  const run = await runtime.submit(projectRequest("pipeline", "recollect-existing"));
  await waitForTerminal(runtime, run.runId);
  const original = await saved(store, run.samplingIds[0]!);
  const originalEvaluation = (await store.listEvaluations(original.samplingId))[0]!;
  for (const method of ["ensureAgent", "submitAgent", "restartAgent", "materializeInitialData", "importEvidence", "exportEvidence", "collectExecution", "collectEvaluation"] as const) vi.mocked(harness[method]).mockClear();
  const { evidence: _evidence, ...withoutEvidence } = original;
  await store.updateSampling({ ...withoutEvidence, execution: { status: "retrying", collectionPending: true } }, original);
  await runtime.resume(run.runId);
  const recovered = await saved(store, original.samplingId);
  expect(recovered.execution).toEqual({ status: "succeeded" });
  expect(recovered.evidence).toBeDefined();
  expect(recovered.executionAttempts).toEqual(original.executionAttempts);
  expect(harness.collectExecution).toHaveBeenCalledTimes(1);
  expect(harness.exportEvidence).toHaveBeenCalledTimes(1);
  const { output: _output, ...withoutOutput } = originalEvaluation;
  await store.updateEvaluation({ ...withoutOutput, status: { status: "retrying", collectionPending: true } }, originalEvaluation);
  await runtime.resume(run.runId);
  const evaluation = await savedEvaluation(store, originalEvaluation.evaluationId);
  expect(evaluation.status).toEqual({ status: "succeeded" });
  expect(evaluation.output).toEqual(originalEvaluation.output);
  expect(evaluation.attempts).toEqual(originalEvaluation.attempts);
  expect(harness.collectEvaluation).toHaveBeenCalledTimes(1);
  for (const method of ["ensureAgent", "submitAgent", "restartAgent", "materializeInitialData", "importEvidence"] as const) expect(harness[method]).not.toHaveBeenCalled();
});

it("ends a failed manual recollection without leaving it pending or re-running the Agent", async () => {
  const harness = makeHarness();
  const store = makeStore();
  const runtime = createAutoResumingRuntime({ harness, store, sleep: async () => undefined, onError: vi.fn() });
  const run = await runtime.submit(projectRequest("pipeline", "recollect-failure"));
  await waitForTerminal(runtime, run.runId);
  const sampling = await saved(store, run.samplingIds[0]!);
  const evaluation = (await store.listEvaluations(sampling.samplingId))[0]!;
  vi.mocked(harness.submitAgent).mockClear();
  vi.mocked(harness.collectExecution).mockRejectedValueOnce(new Error("collection unavailable"));
  await store.updateSampling({ ...sampling, execution: { status: "retrying", collectionPending: true } }, sampling);
  await runtime.resume(run.runId);
  expect((await saved(store, sampling.samplingId)).execution).toMatchObject({ status: "failed", lastError: expect.stringContaining("collection unavailable") });
  expect((await saved(store, sampling.samplingId)).execution.collectionPending).toBeUndefined();
  const failed = await saved(store, sampling.samplingId);
  await store.updateSampling({ ...sampling }, failed);
  vi.mocked(harness.collectEvaluation).mockRejectedValueOnce(new Error("result unavailable"));
  await store.updateEvaluation({ ...evaluation, status: { status: "retrying", collectionPending: true } }, evaluation);
  await runtime.resume(run.runId);
  const recovered = await savedEvaluation(store, evaluation.evaluationId);
  expect(recovered.status).toMatchObject({ status: "failed", lastError: expect.stringContaining("result unavailable") });
  expect(recovered.status.collectionPending).toBeUndefined();
  expect(recovered.attempts).toEqual(evaluation.attempts);
  expect(harness.submitAgent).not.toHaveBeenCalled();
});

it("does not revive a completed pipeline when evaluations move to a later Run", async () => {
  const runtime = createAutoResumingRuntime({ harness: makeHarness(), store: makeStore() });
  runtime.plans.samples = [makeSample("sample-1", { samplingCount: 2 })];
  const first = await runtime.submit(projectRequest("pipeline", "original-pipeline"));
  await waitForTerminal(runtime, first.runId);
  const second = await runtime.submit(evaluationRequest([first.samplingIds[0]!]));
  await waitForTerminal(runtime, second.runId);
  expect(await runtime.getRun(first.runId)).toMatchObject({ status: "succeeded" });
  const third = await runtime.submit(evaluationRequest([first.samplingIds[1]!]));
  await waitForTerminal(runtime, third.runId);
  expect(["succeeded", "failed", "cancelled"]).toContain((await runtime.getRun(first.runId)).status);
});

describe("evaluation result checking", () => {
  const validScore = (_schema: unknown, content: string) => {
    const parsed = JSON.parse(content) as { score?: unknown };
    return typeof parsed.score === "number" ? { valid: true, errors: [] } : { valid: false, errors: ["/score must be number"] };
  };

  async function evaluateOnce(harness: Harness, results: EvaluationResultPort, retryPolicy: RetryPolicy = NO_RETRY) {
    const store = makeStore();
    const runtime = createAutoResumingRuntime({
      plans: makePlans([makeSample("sample-1")], { evaluation: evaluationPlan({ retryPolicy }) }),
      harness, store, results, sleep: async () => undefined,
    });
    const run = await runtime.submit(projectRequest("pipeline", `results-${Math.random()}`));
    await waitForTerminal(runtime, run.runId);
    const record = (await store.getRun(run.runId))!;
    const [evaluation] = await store.getEvaluations(record.evaluationIds);
    return evaluation!;
  }

  const noResult = {
    status: "succeeded" as const, artifacts: [],
    trajectory: { trajectoryId: "trajectory-2", source: "evaluator" as const, path: "/eval/evaluation.jsonl" },
  };

  it("retries a completed evaluation without a submitted score", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    vi.mocked(harness.collectEvaluation).mockResolvedValue(noResult);
    const runtime = createRuntime({
      store, harness, sleep, createRetryController: createProductionRetryController,
      plans: makePlans([makeSample("sample-1")], { evaluation: evaluationPlan({ retryPolicy: RETRY_ONE }) }),
      results: {
        submission: {
          token: () => "t",
          read: async () => vi.mocked(harness.restartAgent).mock.calls.length === 0
            ? undefined : { path: "mcp:submit_evaluation", content: '{"score":8}', source: "submission" },
        },
        check: validScore,
      },
    });
    const run = await runtime.submit(projectRequest("pipeline", "missing-evaluation-result-recovery"));

    await runtime.resume(run.runId);

    const evaluation = (await store.listEvaluations(run.samplingIds[0]!))[0]!;
    expect(evaluation.status.status).toBe("succeeded");
    expect(evaluation.output?.structuredOutput?.source).toBe("submission");
    expect(evaluation.attempts.map((attempt) => attempt.status)).toEqual(["completed", "completed"]);
    expect(harness.restartAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      handle: expect.objectContaining({ role: "evaluator", chatId: evaluation.chatId }),
      idempotencyKey: `evaluation:${evaluation.samplingId}:restart:2`,
      prompt: "Please complete the evaluation, then use the MCP tool to submit the evaluation result.",
    }));
    expect(sleep).toHaveBeenCalledWith(250);
    expect(harness.collectExecution).toHaveBeenCalledTimes(1);
    expect(harness.exportEvidence).toHaveBeenCalledTimes(1);
    expect(harness.importEvidence).toHaveBeenCalledTimes(1);
    expect(harness.readFinalReply).not.toHaveBeenCalled();
  });

  it.each([0, DEFAULT_RETRY_POLICY.maxRestarts])("bounds missing-score recovery by maxRestarts=%i", async (maxRestarts) => {
    const store = makeStore();
    const harness = makeHarness();
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const log = vi.fn();
    const error = RESULT_NOT_SUBMITTED;
    vi.mocked(harness.collectEvaluation).mockResolvedValue(noResult);
    const runtime = createRuntime({
      store, harness, sleep, log, createRetryController: createProductionRetryController,
      plans: makePlans([makeSample("sample-1")], {
        evaluation: evaluationPlan({ retryPolicy: { ...DEFAULT_RETRY_POLICY, maxRestarts } }),
      }),
      results: { submission: { token: () => "t", read: async () => undefined }, check: validScore },
    });
    const run = await runtime.submit(projectRequest("pipeline", `missing-score-budget-${maxRestarts}`));

    await runtime.resume(run.runId);

    const evaluation = (await store.listEvaluations(run.samplingIds[0]!))[0]!;
    expect(evaluation.status).toEqual({ status: "failed", lastError: error });
    expect(evaluation.attempts).toHaveLength(maxRestarts + 1);
    for (const attempt of evaluation.attempts) {
      expect(attempt).toMatchObject({ status: "completed", error, resources: { status: "collected" } });
      expect(store.resourceSnapshot({
        samplingId: evaluation.samplingId, evaluationId: evaluation.evaluationId, attemptId: attempt.evaluationAttemptId,
      })).toBeDefined();
    }
    expect(harness.restartAgent).toHaveBeenCalledTimes(maxRestarts);
    for (const [input] of vi.mocked(harness.restartAgent).mock.calls) {
      expect(input.prompt).toBe("Please complete the evaluation, then use the MCP tool to submit the evaluation result.");
    }
    expect(harness.collectExecution).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1_000, 2_000].slice(0, maxRestarts));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      name: "retry_exhausted", operation: "restart", attemptNumber: maxRestarts + 1, error,
    }));
  });

  it("shares the restart budget between failed Submissions and completed evaluations without scores", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const submit = vi.mocked(harness.submitAgent).getMockImplementation()!;
    vi.mocked(harness.submitAgent).mockImplementation(async (input) => input.handle.role === "evaluator"
      ? { ...makeSubmission("failed", "failed-evaluation"), retryable: true, error: "temporary Agent failure" }
      : submit(input));
    vi.mocked(harness.inspectAgentResources).mockImplementation(async (input) => ({
      scope: { chatId: input.handle.chatId, idempotencyKey: input.idempotencyKey, submissionId: input.submissionId! },
      observedAt: "2026-10-08T00:00:00.000Z", finalized: true, readiness: FINALIZED_READINESS,
    }));
    vi.mocked(harness.collectEvaluation).mockResolvedValue(noResult);
    const runtime = createRuntime({
      store, harness, sleep: async () => undefined,
      plans: makePlans([makeSample("sample-1")], { evaluation: evaluationPlan({ retryPolicy: RETRY_TWO }) }),
      results: { submission: { token: () => "t", read: async () => undefined }, check: validScore },
    });
    const run = await runtime.submit(projectRequest("pipeline", "shared-evaluation-restarts"));

    await runtime.resume(run.runId);

    const evaluation = (await store.listEvaluations(run.samplingIds[0]!))[0]!;
    expect(evaluation.status.status).toBe("failed");
    expect(evaluation.attempts.map(({ status }) => status)).toEqual(["failed", "completed", "completed"]);
    expect(harness.restartAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(harness.restartAgent).mock.calls.map(([input]) => input.prompt)).toEqual([
      expect.stringContaining("Evaluate sample-1"),
      "Please complete the evaluation, then use the MCP tool to submit the evaluation result.",
    ]);
  });

  it("resumes an interrupted recovery backoff with the same persisted restart budget", async () => {
    const store = makeStore();
    store.usePlans(makePlans([makeSample("sample-1")], { evaluation: evaluationPlan({ retryPolicy: RETRY_ONE }) }));
    const harness = makeHarness();
    vi.mocked(harness.collectEvaluation).mockResolvedValue(noResult);
    const results: EvaluationResultPort = {
      submission: {
        token: () => "t",
        read: async () => vi.mocked(harness.restartAgent).mock.calls.length === 0
          ? undefined : { path: "mcp:submit_evaluation", content: '{"score":8}', source: "submission" },
      },
      check: validScore,
    };
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const sleep = vi.fn(() => waiting);
    const run = await createTestAdmission(store).submit(projectRequest("pipeline", "resume-missing-score-recovery"));
    const stop = new AbortController();
    const resumer = createTestResumer(store, harness, { results, sleep, createRetryController: createProductionRetryController });
    const task = resumer.resume(run.runId, stop.signal);
    try {
      await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
      stop.abort();
      await task;

      const pending = (await store.listEvaluations(run.samplingIds[0]!))[0]!;
      expect(pending.status.status).toBe("retrying");
      expect(pending.attempts).toHaveLength(1);
      expect(pending.attempts[0]).toMatchObject({ status: "completed", error: RESULT_NOT_SUBMITTED });
      expect(harness.restartAgent).not.toHaveBeenCalled();

      release();
      await createTestResumer(store, harness, {
        results, sleep: async () => undefined, createRetryController: createProductionRetryController,
      }).resume(run.runId);

      const recovered = (await store.listEvaluations(run.samplingIds[0]!))[0]!;
      expect(recovered.status.status).toBe("succeeded");
      expect(recovered.attempts).toHaveLength(2);
      expect(harness.restartAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        prompt: "Please complete the evaluation, then use the MCP tool to submit the evaluation result.",
      }));
      expect(harness.importEvidence).toHaveBeenCalledOnce();
      expect(harness.collectExecution).toHaveBeenCalledOnce();
    } finally {
      stop.abort();
      release();
      await task;
    }
  });

  it("keeps the resubmission reminder after a reminder Submission fails", async () => {
    const store = makeStore();
    const harness = makeHarness();
    vi.mocked(harness.collectEvaluation).mockResolvedValue(noResult);
    vi.mocked(harness.restartAgent).mockResolvedValueOnce({
      ...makeSubmission("failed", "failed-reminder"), retryable: true, error: "temporary Agent failure",
    });
    const runtime = createRuntime({
      store, harness, sleep: async () => undefined,
      plans: makePlans([makeSample("sample-1")], { evaluation: evaluationPlan({ retryPolicy: RETRY_TWO }) }),
      results: {
        submission: {
          token: () => "t",
          read: async () => vi.mocked(harness.restartAgent).mock.calls.length < 2
            ? undefined : { path: "mcp:submit_evaluation", content: '{"score":8}', source: "submission" },
        },
        check: validScore,
      },
    });
    const run = await runtime.submit(projectRequest("pipeline", "failed-resubmission-reminder"));

    await runtime.resume(run.runId);

    const evaluation = (await store.listEvaluations(run.samplingIds[0]!))[0]!;
    expect(evaluation.status.status).toBe("succeeded");
    expect(evaluation.attempts.map(({ status }) => status)).toEqual(["completed", "failed", "completed"]);
    expect(vi.mocked(harness.restartAgent).mock.calls.map(([input]) => input.prompt)).toEqual([
      "Please complete the evaluation, then use the MCP tool to submit the evaluation result.",
      "Please complete the evaluation, then use the MCP tool to submit the evaluation result.",
    ]);
  });

  it("does not restart when MCP accepts the result while missing-score recovery is being recorded", async () => {
    const store = makeStore();
    const harness = makeHarness();
    vi.mocked(harness.collectEvaluation).mockResolvedValue(noResult);
    const write = store.updateEvaluation.bind(store);
    let accepted = false;
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected, resources) => {
      await write(record, expected, resources);
      if (!accepted && record.attempts.at(-1)?.error === RESULT_NOT_SUBMITTED) {
        accepted = true;
        const current = (await store.getEvaluation(record.evaluationId))!;
        await write({ ...current, status: { status: "succeeded" }, output: {
          ...noResult, structuredOutput: { path: "mcp:submit_evaluation", content: '{"score":8}', source: "submission" },
        } }, current);
      }
    });
    const runtime = createRuntime({
      store, harness, sleep: async () => undefined,
      plans: makePlans([makeSample("sample-1")], { evaluation: evaluationPlan({ retryPolicy: RETRY_ONE }) }),
      results: {
        submission: { token: () => "t", read: async (id) => (await store.getEvaluation(id))?.output?.structuredOutput },
        check: validScore,
      },
    });
    const run = await runtime.submit(projectRequest("pipeline", "accepted-before-missing-score-restart"));

    await runtime.resume(run.runId);

    const evaluation = (await store.listEvaluations(run.samplingIds[0]!))[0]!;
    expect(evaluation.status.status).toBe("succeeded");
    expect(evaluation.output?.structuredOutput?.content).toBe('{"score":8}');
    expect(evaluation.attempts).toHaveLength(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("never dispatches missing-score recovery during a manual output recollection", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const log = vi.fn();
    vi.mocked(harness.collectEvaluation).mockResolvedValue(noResult);
    const runtime = createRuntime({
      store, harness, log, sleep: async () => undefined,
      plans: makePlans([makeSample("sample-1")], { evaluation: evaluationPlan({ retryPolicy: RETRY_ONE }) }),
      results: { submission: { token: () => "t", read: async () => undefined }, check: validScore },
    });
    const run = await runtime.submit(projectRequest("pipeline", "recollect-not-restart"));
    await runtime.resume(run.runId);
    const evaluation = (await store.listEvaluations(run.samplingIds[0]!))[0]!;
    expect(evaluation.status.status).toBe("failed");
    vi.mocked(harness.restartAgent).mockClear();
    log.mockClear();
    await seedEvaluation(store, { ...evaluation, status: { status: "retrying", collectionPending: true } });

    await runtime.resume(run.runId);

    const recollected = (await store.listEvaluations(run.samplingIds[0]!))[0]!;
    expect(recollected.status).toEqual({ status: "failed", lastError: RESULT_NOT_SUBMITTED });
    expect(recollected.attempts).toHaveLength(2);
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.readFinalReply).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "restart" }));
  });

  it("prefers the submitted result and tells the Evaluator to submit it", async () => {
    const harness = makeHarness();
    const evaluation = await evaluateOnce(harness, {
      submission: {
        token: (id) => `token-for-${id}`,
        read: async () => ({ path: "mcp:submit_evaluation", content: '{"score":3}' }),
      },
      check: validScore,
    });
    expect(evaluation.status).toEqual({ status: "succeeded" });
    expect(evaluation.output?.structuredOutput).toEqual({ path: "mcp:submit_evaluation", content: '{"score":3}', source: "submission" });
    const prompt = vi.mocked(harness.submitAgent).mock.calls.find(([call]) => call.handle.role === "evaluator")![0].prompt;
    expect(prompt).toContain(`submit_evaluation MCP tool directly with evaluationId "${evaluation.evaluationId}", submitToken "token-for-${evaluation.evaluationId}"`);
    expect(prompt).not.toContain("/output/result.json");
    expect(harness.readFinalReply).not.toHaveBeenCalled();
  });

  it("keeps the result file and marks its source", async () => {
    const evaluation = await evaluateOnce(makeHarness(), { check: validScore });
    expect(evaluation.status).toEqual({ status: "succeeded" });
    expect(evaluation.output?.structuredOutput?.source).toBe("result-file");
  });

  it("recovers a valid result from the final reply", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectEvaluation).mockResolvedValue(noResult);
    vi.mocked(harness.readFinalReply).mockResolvedValue("I could not write the file.\n```json\n{\"score\": 8}\n```\nRetry later.");
    const evaluation = await evaluateOnce(harness, { check: validScore });
    expect(evaluation.status).toEqual({ status: "succeeded" });
    expect(evaluation.output?.structuredOutput).toEqual({ path: "final-reply", content: '{"score": 8}', source: "final-reply" });
    expect(harness.readFinalReply).toHaveBeenCalledWith(expect.objectContaining({ submissionId: evaluation.attempts.at(-1)!.submissionId }));
  });

  it("does not substitute a file or final reply for a missing MCP acceptance", async () => {
    const harness = makeHarness();
    vi.mocked(harness.readFinalReply).mockResolvedValue('{"score": 8}');
    const evaluation = await evaluateOnce(harness, {
      submission: { token: () => "t", read: async () => undefined }, check: validScore,
    }, DEFAULT_RETRY_POLICY);
    expect(evaluation.status).toEqual({ status: "failed", lastError: RESULT_NOT_SUBMITTED });
    expect(evaluation.output?.structuredOutput).toBeUndefined();
    expect(harness.readFinalReply).not.toHaveBeenCalled();
    expect(harness.restartAgent).toHaveBeenCalledTimes(DEFAULT_RETRY_POLICY.maxRestarts);
  });

  it.each(["disconnect", "completed"] as const)("keeps MCP recovery and acceptance authoritative when observation is %s", async (observation) => {
    const store = makeStore();
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockImplementation(async (input) => input.handle.role === "evaluator"
      ? makeSubmission("running", "evaluation-submission") : makeSubmission("completed"));
    vi.mocked(harness.waitForSubmission).mockRejectedValue(Object.assign(new Error("Submission WebSocket closed before terminal status"), { retryable: true }));
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue(makeSubmission("running", "evaluation-submission"));
    const publish = vi.fn(async () => undefined);
    const runtime = createRuntime({ store, harness, scores: { read: () => ({ score: 8 }), publish }, plans: makePlans([makeSample("sample-1")]),
      results: { submission: { token: () => "t", read: async (id) => (await store.getEvaluation(id))?.output?.structuredOutput }, check: validScore },
    });
    const run = await runtime.submit(projectRequest("pipeline", "mcp-disconnected"));
    await runtime.resume(run.runId);
    const [before] = await store.listEvaluations(run.samplingIds[0]!);
    expect(before!.status.status).toBe("retrying");
    expect(before!.attempts[0]!.status).toBe("running");
    expect(before!.attempts[0]!.completedAt).toBeUndefined();
    expect(harness.restartAgent).not.toHaveBeenCalled();
    const accepted = { ...before!, status: { status: "succeeded" as const }, output: {
      ...noResult, structuredOutput: { path: "mcp:submit_evaluation", content: '{"score":8}', source: "submission" as const },
    } };
    vi.mocked(harness.waitForSubmission).mockImplementation(async () => {
      const current = await savedEvaluation(store, before!.evaluationId);
      await store.updateEvaluation({ ...accepted, attempts: current.attempts }, current);
      if (observation === "completed") return makeSubmission("completed", "evaluation-submission");
      throw Object.assign(new Error("socket closed after MCP acceptance"), { retryable: true });
    });
    await runtime.resume(run.runId);
    expect((await savedEvaluation(store, before!.evaluationId)).status).toEqual({ status: "succeeded" });
    expect((await savedEvaluation(store, before!.evaluationId)).output?.structuredOutput?.content).toBe('{"score":8}');
    expect(publish).toHaveBeenCalledTimes(1);
    if (observation === "completed") {
      const latest = await savedEvaluation(store, before!.evaluationId);
      expect(latest.attempts[0]!.status).toBe("completed");
      expect(latest.attempts[0]!.resources?.status).toBe("collected");
    }
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("does not restart after MCP acceptance races with a failed terminal receipt", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const acceptedOutput = {
      ...noResult,
      structuredOutput: { path: "mcp:submit_evaluation", content: '{"score":8}', source: "submission" as const },
    };
    let accepted = false;
    const updateEvaluation = store.updateEvaluation.bind(store);
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (record, expected) => {
      await updateEvaluation(record, expected);
      if (!accepted && record.attempts.some((attempt) => attempt.status === "failed")
        && record.attempts.at(-1)?.resources?.status === "collected") {
        accepted = true;
        await updateEvaluation({ ...record, status: { status: "succeeded" }, output: acceptedOutput }, record);
      }
    });
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => (
      handle.role === "evaluator" ? makeSubmission("running", "evaluation-submission") : makeSubmission("completed")
    ));
    vi.mocked(harness.waitForSubmission).mockImplementation(async ({ handle }) => (
      handle.role === "evaluator"
        ? { submissionId: "evaluation-submission", status: "failed", retryable: true, error: "late Agent failure" }
        : makeSubmission("completed")
    ));
    const runtime = createRuntime({ store, harness, plans: makePlans([makeSample("sample-1")], {
      evaluation: evaluationPlan({ retryPolicy: RETRY_ONE }),
    }),
      createRetryController: createProductionRetryController,
      results: { submission: { token: () => "t", read: async (id) => (await store.getEvaluation(id))?.output?.structuredOutput }, check: validScore },
    });
    const run = await runtime.submit(projectRequest("pipeline", "mcp-accepted-before-restart"));

    await runtime.resume(run.runId);

    const evaluation = (await store.listEvaluations(run.samplingIds[0]!))[0]!;
    expect(evaluation.status.status).toBe("succeeded");
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("fails as not submitted only after exhausting the Evaluator restart budget", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectEvaluation).mockResolvedValue(noResult);
    const evaluation = await evaluateOnce(harness, { check: validScore }, DEFAULT_RETRY_POLICY);
    expect(evaluation.status).toEqual({ status: "failed", lastError: RESULT_NOT_SUBMITTED });
    expect(vi.mocked(harness.submitAgent).mock.calls.filter(([call]) => call.handle.role === "evaluator")).toHaveLength(1);
    expect(vi.mocked(harness.restartAgent).mock.calls.filter(([call]) => call.handle.role === "evaluator"))
      .toHaveLength(DEFAULT_RETRY_POLICY.maxRestarts);
    expect(evaluation.attempts).toHaveLength(DEFAULT_RETRY_POLICY.maxRestarts + 1);
    for (const [input] of vi.mocked(harness.restartAgent).mock.calls) {
      expect(input.prompt).toContain("Evaluate sample-1");
      expect(input.prompt).toContain("/output/result.json");
    }
  });

  it("fails an invalid result and keeps it as evidence", async () => {
    const harness = makeHarness();
    vi.mocked(harness.collectEvaluation).mockResolvedValue({ ...noResult, structuredOutput: { path: "/output/result.json", content: '{"score":"high"}' } });
    const evaluation = await evaluateOnce(harness, { check: validScore }, DEFAULT_RETRY_POLICY);
    expect(evaluation.status.status).toBe("failed");
    expect(evaluation.status.lastError).toBe(`${RESULT_INVALID_PREFIX} (result-file): /score must be number`);
    expect(evaluation.output?.structuredOutput?.content).toBe('{"score":"high"}');
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(harness.readFinalReply).not.toHaveBeenCalled();
  });
});

describe("resource downloads during Run cancellation", () => {
  const NOW = "2026-10-20T00:00:00.000Z";

  async function setup(sizes: readonly number[]) {
    const samples = Array.from({ length: sizes.reduce((sum, size) => sum + size, 0) }, (_, index) => makeSample(`sample-${index}`));
    const store = makeStore({ plans: makePlans(samples, { execution: executionPlan({ executionConcurrency: 3 }) }) });
    const harness = makeHarness();
    const admission = createTestAdmission(store);
    const runs: RuntimeRunRecord[] = [];
    let offset = 0;
    for (const [index, size] of sizes.entries()) {
      const ids = samples.slice(offset, offset + size).map(({ projectSampleId }) => projectSampleId);
      const admitted = await admission.submit(projectRequest("execution", `resource-stop-${index}`, ids));
      const run = (await store.getRun(admitted.runId))!;
      runs.push(run);
      for (const samplingId of run.samplingIds) {
        await seedSampling(store, {
          ...(await saved(store, samplingId)), subjectChatId: `chat-${samplingId}`, execution: { status: "succeeded" },
          executionAttempts: [{
            executionAttemptId: `attempt-${samplingId}`, samplingId, attemptNumber: 1, status: "completed",
            submissionId: `submission-${samplingId}`, completedAt: NOW,
            resources: { status: "pending", scope: {
              chatId: `chat-${samplingId}`, idempotencyKey: `execution:${samplingId}`, submissionId: `submission-${samplingId}`,
            } },
          }],
        });
      }
      offset += size;
    }
    for (const run of runs) {
      for (const samplingId of run.samplingIds) {
        await seedSampling(store, { ...(await saved(store, samplingId)), execution: {
          status: "succeeded", resourcesPending: { deadline: new Date(Date.parse(NOW) + RESOURCE_WAIT_MS).toISOString(), nextAttemptAt: NOW },
        } });
      }
    }
    let active = 0;
    let peak = 0;
    let automatic = false;
    const downloads: { readonly input: CollectAgentResourcesInput; readonly finish: () => void }[] = [];
    vi.mocked(harness.collectAgentResources).mockImplementation((input) => new Promise((resolve, reject) => {
      active += 1;
      peak = Math.max(peak, active);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        active -= 1;
        if (input.signal?.aborted) reject(input.signal.reason);
        else resolve(makeResources(input));
      };
      downloads.push({ input, finish });
      if (automatic) finish();
    }));
    return {
      store, harness, runs, downloads,
      resumer: createTestResumer(store, harness, { now: () => NOW, sleep: async () => undefined }),
      active: () => active, peak: () => peak,
      finishAll() { automatic = true; downloads.forEach(({ finish }) => finish()); },
    };
  }

  it("cancels one Run's three refreshes without starting queued physical downloads or releasing the active one early", async () => {
    const fixture = await setup([3]);
    const stop = new AbortController();
    let settled = false;
    const task = fixture.resumer.resume(fixture.runs[0]!.runId, stop.signal).then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(fixture.harness.inspectAgentResources).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(fixture.downloads).toHaveLength(1));
      stop.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fixture.downloads).toHaveLength(1);
      expect(fixture.downloads[0]!.input.signal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(fixture.active()).toBe(1);
      fixture.downloads[0]!.finish();
      await task;
      expect(fixture.active()).toBe(0);
      expect(fixture.peak()).toBe(1);
      expect(fixture.downloads).toHaveLength(1);
    } finally {
      fixture.finishAll();
      await task;
    }
  });

  it("keeps another Run behind the physical cancellation and cleanup of an active download", async () => {
    const fixture = await setup([1, 1]);
    const stop = new AbortController();
    const first = fixture.resumer.resume(fixture.runs[0]!.runId, stop.signal);
    await vi.waitFor(() => expect(fixture.downloads).toHaveLength(1));
    const second = fixture.resumer.resume(fixture.runs[1]!.runId);
    try {
      await vi.waitFor(() => expect(fixture.harness.inspectAgentResources).toHaveBeenCalledTimes(2));
      stop.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fixture.downloads).toHaveLength(1);
      expect(fixture.active()).toBe(1);
      fixture.downloads[0]!.finish();
      await first;
      await vi.waitFor(() => expect(fixture.downloads).toHaveLength(2));
      expect(fixture.peak()).toBe(1);
      fixture.downloads[1]!.finish();
      await second;
      expect(fixture.active()).toBe(0);
    } finally {
      fixture.finishAll();
      await Promise.all([first, second]);
    }
  });

  it("cancels a queued Run promptly without counting or starting its download", async () => {
    const fixture = await setup([1, 1]);
    const first = fixture.resumer.resume(fixture.runs[0]!.runId);
    await vi.waitFor(() => expect(fixture.downloads).toHaveLength(1));
    const stop = new AbortController();
    let settled = false;
    const second = fixture.resumer.resume(fixture.runs[1]!.runId, stop.signal).then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(fixture.harness.inspectAgentResources).toHaveBeenCalledTimes(2));
      stop.abort();
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(fixture.active()).toBe(1);
      const queued = await saved(fixture.store, fixture.runs[1]!.samplingIds[0]!);
      expect(queued.executionAttempts[0]!.resources).not.toHaveProperty("downloads");
      fixture.downloads[0]!.finish();
      await first;
      expect(fixture.downloads).toHaveLength(1);
      expect(fixture.peak()).toBe(1);
    } finally {
      fixture.finishAll();
      await Promise.all([first, second]);
    }
  });

  it.each(["readiness", "download-backoff", "count-persistence"] as const)("stops during %s sleep without retrying or blocking finalization", async (during) => {
    const fixture = await setup([1]);
    const samplingId = fixture.runs[0]!.samplingIds[0]!;
    if (during === "readiness") {
      const current = await saved(fixture.store, samplingId);
      await seedSampling(fixture.store, { ...current, execution: { ...current.execution, status: "retrying" } });
      mockReadiness(fixture.harness, () => false);
    }
    if (during === "download-backoff") {
      vi.mocked(fixture.harness.collectAgentResources).mockRejectedValue(new Error("SP unavailable"));
    }
    if (during === "count-persistence") {
      const write = fixture.store.updateSampling.bind(fixture.store);
      vi.spyOn(fixture.store, "updateSampling").mockImplementation(async (record, expected, resources) => {
        if (record.executionAttempts[0]?.resources?.status === "pending" && record.executionAttempts[0].resources.downloads) {
          throw new Error("database temporarily unavailable");
        }
        await write(record, expected, resources);
      });
    }
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const sleep = vi.fn(() => waiting);
    const onError = vi.fn();
    const resumer = createTestResumer(fixture.store, fixture.harness, {
      now: () => NOW, sleep, onError, createRetryController: createProductionRetryController,
    });
    const stop = new AbortController();
    let settled = false;
    const task = resumer.resume(fixture.runs[0]!.runId, stop.signal).then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
      stop.abort();
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(fixture.harness.collectAgentResources).toHaveBeenCalledTimes(during === "download-backoff" ? 1 : 0);
      expect(onError).not.toHaveBeenCalled();
      const readRun = fixture.store.getRun.bind(fixture.store);
      vi.spyOn(fixture.store, "getRun").mockImplementation(async (runId) => {
        const run = await readRun(runId);
        return run && { ...run, stopRequested: true };
      });
      await resumer.stop(fixture.runs[0]!.runId);
      const stopped = await saved(fixture.store, samplingId);
      expect(stopped.execution).not.toHaveProperty("resourcesPending");
      expect(stopped.executionAttempts[0]!.resources?.status).toBe("failed");
      expect(onError).not.toHaveBeenCalled();
    } finally {
      release();
      fixture.finishAll();
      await task;
    }
  });
});

describe("resource readiness waiting and Submission observation", () => {
  const START = "2026-10-20T00:00:00.000Z";
  const DEADLINE = new Date(Date.parse(START) + RESOURCE_WAIT_MS).toISOString();
  const FIRST_CHECK = new Date(Date.parse(START) + RESOURCE_CHECK_INTERVAL_MS).toISOString();
  const socketClosed = () => Object.assign(new Error("Submission WebSocket closed before terminal status"), { retryable: true });
  const unfinalized = (input: CollectAgentResourcesInput): AgentResourceSnapshot => ({
    ...makeResources(input), finalized: false, readiness: PENDING_READINESS,
    coverage: { usageEvents: "partial", nativeRecords: "partial", billingSettlements: "partial" },
  });
  const validScore = (_schema: unknown, content: string) => (
    typeof (JSON.parse(content) as { score?: unknown }).score === "number"
      ? { valid: true, errors: [] } : { valid: false, errors: ["/score must be number"] }
  );

  it("checks readiness at 0, 5, 10, 20 and 40 seconds after the Agent ends and downloads only the finalized snapshot", async () => {
    const store = makeStore();
    const harness = makeHarness();
    let checks = 0;
    mockReadiness(harness, () => ++checks >= 3);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const runtime = createRuntime({ harness, store, sleep });
    const run = await runtime.submit(projectRequest("execution", "readiness-then-download"));

    await runtime.resume(run.runId);
    const sampling = await saved(store, run.samplingIds[0]!);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([5_000, 10_000]);
    expect(harness.inspectAgentResources).toHaveBeenCalledTimes(3);
    expect(harness.collectAgentResources).toHaveBeenCalledOnce();
    expect(vi.mocked(harness.collectAgentResources).mock.invocationCallOrder[0]!)
      .toBeGreaterThan(vi.mocked(harness.inspectAgentResources).mock.invocationCallOrder[2]!);
    expect(sampling.execution).toEqual({ status: "succeeded" });
    expect(sampling.executionAttempts[0]!.resources).toMatchObject({ status: "collected", summary: { finalized: true } });
  });

  it("never downloads an unfinalized snapshot: it waits across passes on readiness alone and downloads once when finalized", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const clock = testClock(START);
    let ready = false;
    mockReadiness(harness, () => ready);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const runtime = createRuntime({ harness, store, sleep, now: clock.now });
    const run = await runtime.submit(projectRequest("execution", "readiness-across-passes"));
    const samplingId = run.samplingIds[0]!;

    await runtime.resume(run.runId);
    const first = await saved(store, samplingId);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(first.execution).toEqual({ status: "succeeded", resourcesPending: { deadline: DEADLINE, nextAttemptAt: FIRST_CHECK } });
    expect(isStageRecoveryPending(first.execution)).toBe(true);
    expect(first.executionAttempts[0]!.resources?.status).toBe("pending");
    expect(first.evidence).toBeDefined();
    expect((await runtime.getRun(run.runId)).status).toBe("succeeded");

    clock.advance(60_000);
    await runtime.resume(run.runId);
    const waiting = await saved(store, samplingId);
    expect(waiting.execution).toEqual({ status: "succeeded", resourcesPending: {
      deadline: DEADLINE,
      nextAttemptAt: new Date(Date.parse(START) + 120_000).toISOString(),
      lastError: expect.stringContaining("resource snapshot is not finalized"),
    } });
    await runtime.resume(run.runId);
    expect(harness.inspectAgentResources).toHaveBeenCalledTimes(6);
    expect(harness.collectAgentResources).not.toHaveBeenCalled();

    ready = true;
    clock.advance(60_000);
    await runtime.resume(run.runId);
    const refreshed = await saved(store, samplingId);
    expect(refreshed.execution).toEqual({ status: "succeeded" });
    expect(refreshed.executionAttempts[0]!.resources).toMatchObject({ status: "collected", summary: { finalized: true } });
    expect(refreshed.evidence).toEqual(first.evidence);
    expect(harness.collectAgentResources).toHaveBeenCalledOnce();
    expect(harness.collectAgentResources).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `execution:${samplingId}`, submissionId: first.executionAttempts[0]!.submissionId,
    }));
    expect(harness.ensureAgent).toHaveBeenCalledOnce();
    expect(harness.submitAgent).toHaveBeenCalledOnce();
    expect(harness.collectExecution).toHaveBeenCalledOnce();
    expect(harness.exportEvidence).toHaveBeenCalledOnce();

    clock.advance(RESOURCE_WAIT_MS);
    await runtime.resume(run.runId);
    expect(harness.inspectAgentResources).toHaveBeenCalledTimes(7);
    expect(harness.collectAgentResources).toHaveBeenCalledOnce();
  });

  it("stores the current snapshot once at the ten-minute deadline, ends the wait and reports it once", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const clock = testClock(START);
    const reported = vi.fn();
    mockReadiness(harness, () => false);
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => unfinalized(input));
    const runtime = createRuntime({ harness, store, sleep: async () => undefined, now: clock.now, onError: reported });
    const run = await runtime.submit(projectRequest("execution", "readiness-deadline"));
    const samplingId = run.samplingIds[0]!;
    await runtime.resume(run.runId);

    clock.advance(RESOURCE_WAIT_MS - 30_000);
    await runtime.resume(run.runId);
    expect((await saved(store, samplingId)).execution.resourcesPending).toMatchObject({ deadline: DEADLINE, nextAttemptAt: DEADLINE });
    expect(harness.collectAgentResources).not.toHaveBeenCalled();

    clock.advance(30_000);
    await runtime.resume(run.runId);
    const final = await saved(store, samplingId);
    expect(final.execution).toEqual({ status: "succeeded" });
    expect(final.executionAttempts[0]!.resources).toMatchObject({ status: "collected", summary: { finalized: false, readiness: PENDING_READINESS } });
    expect(harness.collectAgentResources).toHaveBeenCalledOnce();
    expect(harness.collectAgentResources).toHaveBeenCalledWith(expect.objectContaining({
      allowPartial: true, idempotencyKey: `execution:${samplingId}`,
      submissionId: final.executionAttempts[0]!.submissionId,
    }));
    expect(reported).toHaveBeenCalledOnce();
    const [error] = reported.mock.calls[0]! as [Error];
    expect(error.message).toContain(`execution resources for sampling ${samplingId}, Chat ${final.subjectChatId} were not finalized by ${DEADLINE}`);
    expect(error.message).not.toContain("usageEvents");

    clock.advance(RESOURCE_WAIT_MS);
    await runtime.resume(run.runId);
    expect(harness.collectAgentResources).toHaveBeenCalledOnce();
    expect(reported).toHaveBeenCalledOnce();
  });

  it("checks readiness once and downloads nothing while the Submission status is uncertain", async () => {
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValue(makeSubmission("running", "submission-1"));
    vi.mocked(harness.waitForSubmission).mockRejectedValue(socketClosed());
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue(null);
    mockReadiness(harness, () => false);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const store = makeStore();
    const runtime = createRuntime({ harness, store, sleep });
    const run = await runtime.submit(projectRequest("execution", "uncertain-readiness"));

    await runtime.resume(run.runId);
    const sampling = await saved(store, run.samplingIds[0]!);
    expect(sampling.execution).toMatchObject({ status: "retrying", observationPending: { passes: 1 } });
    expect(sampling.execution).not.toHaveProperty("resourcesPending");
    expect(sampling.executionAttempts[0]!.resources?.status).toBe("pending");
    expect(harness.inspectAgentResources).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(harness.collectAgentResources).not.toHaveBeenCalled();
  });

  it("ends a resource wait that has no Chat instead of repeating it every pass", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const clock = testClock(START);
    mockReadiness(harness, () => false);
    const onError = vi.fn();
    const runtime = createRuntime({ harness, store, sleep: async () => undefined, onError, now: clock.now });
    const run = await runtime.submit(projectRequest("execution", "refresh-without-chat"));
    const samplingId = run.samplingIds[0]!;
    await runtime.resume(run.runId);
    const flagged = await saved(store, samplingId);
    expect(flagged.execution.resourcesPending).toBeDefined();
    const { subjectChatId: _chat, ...withoutChat } = flagged;
    await store.updateSampling(withoutChat, flagged);
    onError.mockClear();

    clock.advance(RESOURCE_CHECK_INTERVAL_MS);
    await runtime.resume(run.runId);
    expect((await saved(store, samplingId)).execution).toEqual({ status: "succeeded" });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("were not read: no Chat") }),
      { runId: run.runId, stage: "execution", samplingId });
    expect(harness.collectAgentResources).not.toHaveBeenCalled();
  });

  it("waits for an MCP-accepted evaluation's snapshot while keeping its accepted result", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const clock = testClock(START);
    let evaluatorReady = false;
    mockReadiness(harness, (input) => input.handle.role !== "evaluator" || evaluatorReady);
    const runtime = createRuntime({
      harness, store, sleep: async () => undefined, now: clock.now, plans: makePlans([makeSample("sample-1")]),
      results: { submission: { token: () => "t", read: async () => ({ path: "mcp:submit_evaluation", content: '{"score":3}' }) }, check: validScore },
    });
    const run = await runtime.submit(projectRequest("pipeline", "refresh-accepted-evaluation"));
    await runtime.resume(run.runId);
    const evaluationId = (await runtime.getRun(run.runId)).evaluationIds[0]!;
    const first = await savedEvaluation(store, evaluationId);
    expect(first.status).toEqual({ status: "succeeded", resourcesPending: { deadline: expect.any(String), nextAttemptAt: expect.any(String) } });
    expect(first.output?.structuredOutput?.source).toBe("submission");

    evaluatorReady = true;
    clock.advance(RESOURCE_CHECK_INTERVAL_MS);
    await runtime.resume(run.runId);
    const refreshed = await savedEvaluation(store, evaluationId);
    expect(refreshed.status).toEqual({ status: "succeeded" });
    expect(refreshed.output).toEqual(first.output);
    expect(refreshed.attempts[0]!.resources).toMatchObject({ status: "collected", summary: { finalized: true } });
    expect(vi.mocked(harness.collectAgentResources).mock.calls.filter(([call]) => call.handle.role === "evaluator")).toHaveLength(1);
    expect(vi.mocked(harness.submitAgent).mock.calls.filter(([call]) => call.handle.role === "evaluator")).toHaveLength(1);
    expect(vi.mocked(harness.ensureAgent).mock.calls.filter(([call]) => call.role === "evaluator")).toHaveLength(1);
    expect(harness.collectEvaluation).toHaveBeenCalledOnce();
  });

  it.each(["synced", "failed"] as const)("syncs an accepted score before recovering resources after a Worker restart (%s)", async (delivery) => {
    const store = makeStore();
    const harness = makeHarness();
    const clock = testClock(START);
    const run = await createTestAdmission(store).submit(projectRequest("pipeline", "accepted-score-after-worker-restart"));
    const record = (await store.getRun(run.runId))!;
    const samplingId = record.samplingIds[0]!;
    const evaluationId = record.evaluationIds[0]!;
    await seedSampling(store, {
      ...(await saved(store, samplingId)), subjectChatId: "subject-chat", execution: { status: "succeeded" },
      artifacts: [], trajectory: { trajectoryId: "subject-trace", source: "subject", path: "/subject.jsonl" },
    });
    const initial = await savedEvaluation(store, evaluationId);
    const input: CollectAgentResourcesInput = {
      handle: { ownerUserId: EVALUATOR.ownerUserId, role: "evaluator", framework: "sp", chatId: "evaluation-chat", samplingId, evaluationId },
      idempotencyKey: `evaluation:${samplingId}`, submissionId: "evaluation-submission",
    };
    const snapshot = makeResources(input);
    await store.updateEvaluation({
      ...initial, chatId: input.handle.chatId,
      attempts: [{
        evaluationAttemptId: "accepted-attempt", evaluationId, attemptNumber: 1,
        submissionId: input.submissionId!, status: "completed", startedAt: START, completedAt: START,
        resources: { status: "pending", scope: snapshot.scope, downloads: 1 },
      }],
      status: { status: "succeeded", resourcesPending: { deadline: DEADLINE, nextAttemptAt: FIRST_CHECK } },
      output: {
        status: "succeeded", artifacts: [],
        trajectory: { trajectoryId: "evaluation-trace", source: "evaluator", path: "/evaluation.jsonl" },
        structuredOutput: { path: "mcp:submit_evaluation", content: '{"score":8}', source: "submission" },
      },
    }, initial);
    const publish = vi.fn(async () => {
      if (delivery === "failed") throw new Error("Langfuse unavailable");
    });
    const onError = vi.fn();
    clock.advance(RESOURCE_CHECK_INTERVAL_MS);

    await createTestResumer(store, harness, {
      now: clock.now, sleep: async () => undefined, scores: { read: () => ({ score: 8 }), publish },
      createRetryController: createProductionRetryController, onError,
    }).resume(run.runId);

    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      evaluationId, samplingId, subjectChatId: "subject-chat", evaluatorChatId: "evaluation-chat", score: 8,
    }));
    expect(publish.mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(harness.collectAgentResources).mock.invocationCallOrder[0]!);
    const recovered = await savedEvaluation(store, evaluationId);
    expect(recovered.status).toEqual({ status: "succeeded" });
    expect(recovered.scoreSync).toMatchObject({ status: delivery });
    expect(recovered.attempts[0]!.resources?.status).toBe("collected");
    if (delivery === "failed") {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining("score was not synced: Langfuse unavailable"),
      }), expect.objectContaining({ evaluationId }));
    }
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it.each(["pending", "finalized"] as const)("keeps the accepted Evaluator's %s resource wait recoverable when confirmed terminal writes fail", async (resources) => {
    const store = makeStore();
    const harness = makeHarness();
    const clock = testClock(START);
    const run = await createTestAdmission(store).submit(projectRequest("pipeline", `receipt-before-resources-${resources}`));
    const record = (await store.getRun(run.runId))!;
    const samplingId = record.samplingIds[0]!;
    const evaluationId = record.evaluationIds[0]!;
    await seedSampling(store, {
      ...(await saved(store, samplingId)), subjectChatId: "subject-chat", execution: { status: "succeeded" },
      artifacts: [], trajectory: { trajectoryId: "subject-trace", source: "subject", path: "/subject.jsonl" },
    });
    const initial = await savedEvaluation(store, evaluationId);
    const input: CollectAgentResourcesInput = {
      handle: { ownerUserId: EVALUATOR.ownerUserId, role: "evaluator", framework: "sp", chatId: "evaluation-chat", samplingId, evaluationId },
      idempotencyKey: `evaluation:${samplingId}`, submissionId: "evaluation-submission",
    };
    const snapshot = makeResources(input);
    const attempt: EvaluationState["attempts"][number] = {
      evaluationAttemptId: "accepted-attempt", evaluationId, attemptNumber: 1,
      submissionId: input.submissionId!, status: "running", startedAt: START,
      resources: resources === "finalized"
        ? { status: "collected", summary: summarizeResourceSnapshot(snapshot) }
        : { status: "pending", scope: snapshot.scope },
    };
    await store.updateEvaluation({
      ...initial, chatId: input.handle.chatId, attempts: [attempt],
      status: { status: "succeeded", resourcesPending: { deadline: DEADLINE, nextAttemptAt: FIRST_CHECK } },
      output: {
        status: "succeeded", artifacts: [],
        trajectory: { trajectoryId: "evaluation-trace", source: "evaluator", path: "/evaluation.jsonl" },
        structuredOutput: { path: "mcp:submit_evaluation", content: '{"score":8}', source: "submission" },
      },
    }, initial, resources === "finalized" ? { attemptId: attempt.evaluationAttemptId, snapshot } : undefined);
    const accepted = await savedEvaluation(store, evaluationId);
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue(makeSubmission("completed", input.submissionId!));
    vi.mocked(harness.collectAgentResources).mockResolvedValue(snapshot);
    const write = store.updateEvaluation.bind(store);
    let unavailable = true;
    const rejectedCompletions: string[] = [];
    vi.spyOn(store, "updateEvaluation").mockImplementation(async (next, expected, collected) => {
      const completedAt = next.attempts[0]?.completedAt;
      if (unavailable && completedAt !== undefined) {
        rejectedCompletions.push(completedAt);
        clock.advance(1_000);
        throw new Error("confirmed terminal persistence unavailable");
      }
      await write(next, expected, collected);
    });
    const publish = vi.fn(async () => undefined);
    const options = {
      now: clock.now, sleep: async () => undefined, onError: vi.fn(),
      createRetryController: createProductionRetryController,
      scores: { read: () => ({ score: 8 }), publish },
    };
    clock.advance(RESOURCE_CHECK_INTERVAL_MS);
    await expect(createTestResumer(store, harness, options).resume(run.runId)).rejects.toBeInstanceOf(AggregateError);
    const waiting = await savedEvaluation(store, evaluationId);
    expect(rejectedCompletions).toHaveLength(11);
    expect(new Set(rejectedCompletions)).toEqual(new Set([FIRST_CHECK]));
    expect(isStageRecoveryPending(waiting.status)).toBe(true);
    expect(waiting.status).toEqual(accepted.status);
    expect(waiting.output).toEqual(accepted.output);
    expect(waiting.attempts).toEqual(accepted.attempts);
    expect(waiting.scoreSync).toMatchObject({ status: "synced" });
    expect(publish).toHaveBeenCalledOnce();
    expect(harness.inspectAgentOperation).toHaveBeenCalledOnce();
    expect(harness.inspectAgentResources).not.toHaveBeenCalled();
    expect(harness.collectAgentResources).not.toHaveBeenCalled();

    unavailable = false;
    const restarted = createTestResumer(store, harness, options);
    await restarted.resume(run.runId);
    const recovered = await savedEvaluation(store, evaluationId);
    expect(recovered.status).toEqual({ status: "succeeded" });
    expect(isStageRecoveryPending(recovered.status)).toBe(false);
    expect(recovered.output).toEqual(accepted.output);
    expect(recovered.attempts[0]).toMatchObject({ status: "completed", startedAt: START, completedAt: clock.now() });
    expect(Date.parse(recovered.attempts[0]!.completedAt!) - Date.parse(recovered.attempts[0]!.startedAt!)).toBeGreaterThan(0);
    expect(recovered.attempts[0]!.resources).toMatchObject({ status: "collected", summary: { finalized: true } });
    expect(store.resourceSnapshot({ samplingId, evaluationId, attemptId: attempt.evaluationAttemptId })).toBe(snapshot);
    expect(harness.inspectAgentOperation).toHaveBeenCalledTimes(2);
    expect(harness.inspectAgentResources).toHaveBeenCalledTimes(resources === "pending" ? 1 : 0);
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(resources === "pending" ? 1 : 0);
    expect(publish).toHaveBeenCalledOnce();
    await restarted.resume(run.runId);
    expect(harness.inspectAgentOperation).toHaveBeenCalledTimes(2);
    expect(harness.inspectAgentResources).toHaveBeenCalledTimes(resources === "pending" ? 1 : 0);
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(resources === "pending" ? 1 : 0);
    expect(harness.submitAgent).not.toHaveBeenCalled();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("keeps an exhausted accepted Evaluation's raw snapshot until an explicit manual budget reset", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const onError = vi.fn();
    mockReadiness(harness, (input) => input.handle.role !== "evaluator");
    const runtime = createRuntime({
      harness, store, onError, now: () => START, sleep: async () => undefined,
      createRetryController: createProductionRetryController,
      results: { submission: { token: () => "t", read: async () => ({ path: "mcp:submit_evaluation", content: '{"score":3}' }) }, check: validScore },
    });
    const run = await runtime.submit(projectRequest("pipeline", "exhausted-accepted-snapshot"));
    await runtime.resume(run.runId);
    const evaluationId = (await runtime.getRun(run.runId)).evaluationIds[0]!;
    const accepted = await savedEvaluation(store, evaluationId);
    const original = accepted.attempts[0]!;
    const { completedAt: _completed, ...unobserved } = original;
    const input = {
      handle: {
        ownerUserId: EVALUATOR.ownerUserId, role: "evaluator" as const, framework: "sp" as const,
        samplingId: accepted.samplingId, chatId: accepted.chatId!, evaluationId,
      },
      idempotencyKey: `evaluation:${accepted.samplingId}`, submissionId: original.submissionId!,
    };
    const raw = unfinalized(input);
    await store.updateEvaluation({
      ...accepted,
      status: { status: "succeeded", resourcesPending: { deadline: DEADLINE, nextAttemptAt: START } },
      attempts: [{ ...unobserved, status: "running", resources: { status: "collected", summary: summarizeResourceSnapshot(raw), downloads: 11 } }],
    }, accepted, { attemptId: original.evaluationAttemptId, snapshot: raw });
    vi.mocked(harness.inspectAgentResources).mockClear();
    vi.mocked(harness.inspectAgentOperation).mockClear();
    vi.mocked(harness.collectAgentResources).mockClear();

    await runtime.resume(run.runId);
    const exhausted = await savedEvaluation(store, evaluationId);
    expect(exhausted.status).toEqual({ status: "succeeded" });
    expect(exhausted.output).toEqual(accepted.output);
    expect(exhausted.attempts[0]!.resources).toMatchObject({
      status: "collected", downloads: 11, exhausted: true, summary: summarizeResourceSnapshot(raw),
    });
    expect(store.resourceSnapshot({ samplingId: accepted.samplingId, evaluationId, attemptId: original.evaluationAttemptId })).toBe(raw);
    expect(harness.inspectAgentResources).not.toHaveBeenCalled();
    expect(harness.inspectAgentOperation).not.toHaveBeenCalled();
    expect(harness.collectAgentResources).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    await runtime.resume(run.runId);
    expect(onError).toHaveBeenCalledOnce();

    await store.updateEvaluation({
      ...exhausted,
      status: { status: "succeeded", resourcesPending: { deadline: DEADLINE, nextAttemptAt: START } },
      attempts: withFreshResourceBudget(exhausted.attempts),
    }, exhausted);
    mockReadiness(harness, () => true);
    await runtime.resume(run.runId);
    const recollected = await savedEvaluation(store, evaluationId);
    expect(recollected.status).toEqual({ status: "succeeded" });
    expect(recollected.output).toEqual(accepted.output);
    expect(recollected.attempts[0]!.resources).toMatchObject({ status: "collected", summary: { finalized: true } });
    expect(recollected.attempts[0]!.resources).not.toHaveProperty("downloads");
    expect(recollected.attempts[0]!.resources).not.toHaveProperty("exhausted");
    expect(harness.collectAgentResources).toHaveBeenCalledOnce();
    expect(harness.submitAgent).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("re-collects failed resources of a terminal Attempt instead of keeping the failure", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const runtime = createRuntime({ harness, store, sleep: async () => undefined });
    const run = await runtime.submit(projectRequest("execution", "recollect-failed-resources"));
    const samplingId = run.samplingIds[0]!;
    const chatId = "subject-chat";
    await seedSampling(store, {
      ...(await saved(store, samplingId)),
      subjectChatId: chatId,
      execution: { status: "retrying" },
      executionAttempts: [{
        executionAttemptId: "terminal-with-failed-resources", samplingId, attemptNumber: 1,
        submissionId: "submission-1", status: "completed", startedAt: "2026-10-09T00:00:00.000Z",
        completedAt: "2026-10-09T00:01:00.000Z",
        resources: {
          status: "failed", scope: { chatId, idempotencyKey: `execution:${samplingId}`, submissionId: "submission-1" },
          collectedAt: "2026-10-09T00:01:00.000Z", error: "resource source unavailable",
        },
      }],
    });
    vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));

    await runtime.resume(run.runId);

    const persisted = await saved(store, samplingId);
    expect(persisted.execution).toEqual({ status: "succeeded" });
    expect(persisted.executionAttempts[0]!.resources).toMatchObject({ status: "collected", summary: { finalized: true } });
    expect(harness.collectAgentResources).toHaveBeenCalledOnce();
    expect(harness.submitAgent).not.toHaveBeenCalled();
  });

  it("retries a failed download within the resources retry budget and stores the snapshot outside the stage record", async () => {
    const store = makeStore();
    const harness = makeHarness();
    vi.mocked(harness.collectAgentResources)
      .mockRejectedValueOnce(new Error("resource source unavailable"))
      .mockImplementation(async (input) => makeResources(input));
    const runtime = createRuntime({ harness, store, sleep: async () => undefined, createRetryController: createProductionRetryController });
    const run = await runtime.submit(projectRequest("execution", "refresh-failed-resources"));
    await runtime.resume(run.runId);
    const persisted = await saved(store, run.samplingIds[0]!);
    const attempt = persisted.executionAttempts[0]!;
    expect(persisted.execution).toEqual({ status: "succeeded" });
    expect(attempt.resources).toMatchObject({ status: "collected", summary: { finalized: true, counts: { usageEvents: 1 } } });
    expect(attempt.resources).not.toHaveProperty("downloads");
    expect(store.resourceSnapshot({ samplingId: persisted.samplingId, attemptId: attempt.executionAttemptId }))
      .toEqual(await vi.mocked(harness.collectAgentResources).mock.results[1]!.value);
    expect(harness.collectAgentResources).toHaveBeenCalledTimes(2);
    expect(harness.submitAgent).toHaveBeenCalledOnce();
  });

  describe("a download a crashed Worker started", () => {
    async function crashedDownload(key: string, downloads: number, readiness?: "pending" | "error", lifecycle = false) {
      const store = makeStore();
      const harness = makeHarness();
      const onError = vi.fn();
      if (readiness === "pending") mockReadiness(harness, () => false);
      if (readiness === "error") vi.mocked(harness.inspectAgentResources).mockRejectedValue(new Error("SP unavailable"));
      vi.mocked(harness.collectAgentResources).mockImplementation(async (input) => makeResources(input));
      const runtime = createRuntime({ harness, store, onError, sleep: async () => undefined, now: () => START, createRetryController: createProductionRetryController });
      const run = await runtime.submit(projectRequest("execution", key));
      const samplingId = run.samplingIds[0]!;
      await seedSampling(store, {
        ...(await saved(store, samplingId)),
        subjectChatId: "subject-chat",
        execution: lifecycle ? { status: "retrying" } : { status: "succeeded", resourcesPending: { deadline: DEADLINE, nextAttemptAt: START } },
        artifacts: [{ artifactId: "subject-file", kind: "file", path: "/subject.txt" }],
        trajectory: { trajectoryId: "subject-trace", source: "subject", path: "/subject.jsonl" },
        executionAttempts: [{
          executionAttemptId: "crashed-download", samplingId, attemptNumber: 1, status: "completed",
          submissionId: "submission-1", startedAt: START, completedAt: START,
          resources: { status: "pending", scope: { chatId: "subject-chat", idempotencyKey: `execution:${samplingId}`, submissionId: "submission-1" }, downloads },
        }],
      });
      await runtime.resume(run.runId);
      return { harness, runtime, run, onError, persisted: await saved(store, samplingId) };
    }

    it("counts against the same retry budget before the next download", async () => {
      const { harness, persisted } = await crashedDownload("crashed-download-retried", 3);
      expect(harness.collectAgentResources).toHaveBeenCalledOnce();
      expect(persisted.execution).toEqual({ status: "succeeded" });
      expect(persisted.executionAttempts[0]!.resources).toMatchObject({ status: "collected", summary: { finalized: true } });
    });

    it("gives the resources up without downloading once crashes spent the budget, so the Run finishes", async () => {
      const { harness, runtime, run, onError, persisted } = await crashedDownload("crashed-download-exhausted", 11);
      expect(harness.inspectAgentResources).not.toHaveBeenCalled();
      expect(harness.collectAgentResources).not.toHaveBeenCalled();
      expect(persisted.execution).toEqual({ status: "succeeded" });
      expect(persisted.executionAttempts[0]!.resources).toMatchObject({ status: "failed", downloads: 11, exhausted: true });
      await expect(runtime.getRun(run.runId)).resolves.toMatchObject({ status: "succeeded" });
      expect(onError).toHaveBeenCalledOnce();
      await runtime.resume(run.runId);
      expect(onError).toHaveBeenCalledOnce();
    });

    it.each(["pending", "error"] as const)("finishes exhausted resources without reading %s readiness in either entry", async (readiness) => {
      for (const lifecycle of [false, true]) {
        const { harness, runtime, run, onError, persisted } = await crashedDownload(`exhausted-${readiness}-${lifecycle}`, 11, readiness, lifecycle);
        expect(harness.inspectAgentResources).not.toHaveBeenCalled();
        expect(harness.collectAgentResources).not.toHaveBeenCalled();
        expect(persisted.execution).toEqual({ status: "succeeded" });
        expect(persisted.executionAttempts[0]).toMatchObject({
          status: "completed", completedAt: START, resources: { status: "failed", downloads: 11, exhausted: true },
        });
        expect(onError).toHaveBeenCalledOnce();
        await runtime.resume(run.runId);
        expect(onError).toHaveBeenCalledOnce();
      }
    });
  });

  it("persists an unconfirmed terminal status and re-observes the same Submission on the next pass", async () => {
    const store = makeStore();
    const harness = makeHarness();
    const reported = vi.fn();
    vi.mocked(harness.submitAgent).mockResolvedValue(makeSubmission("running", "submission-1"));
    vi.mocked(harness.waitForSubmission).mockRejectedValue(socketClosed());
    vi.mocked(harness.inspectAgentOperation).mockResolvedValue(null);
    const runtime = createRuntime({ harness, store, sleep: async () => undefined, onError: reported });
    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_TWO });
    const run = await runtime.submit(projectRequest("execution", "observation-pending"));
    const samplingId = run.samplingIds[0]!;

    await runtime.resume(run.runId);
    const pending = await saved(store, samplingId);
    expect(pending.execution).toMatchObject({
      status: "retrying",
      observationPending: { passes: 1, lastError: expect.stringContaining("inspect: null") },
    });
    expect(pending.execution.lastError).toContain("Submission WebSocket closed before terminal status");
    expect(pending.executionAttempts).toHaveLength(1);
    expect(pending.executionAttempts[0]).toMatchObject({ submissionId: "submission-1", status: "running" });

    vi.mocked(harness.waitForSubmission).mockResolvedValue(makeSubmission("completed", "submission-1"));
    await runtime.resume(run.runId);
    const persisted = await saved(store, samplingId);
    expect(persisted.execution).toEqual({ status: "succeeded" });
    expect(persisted.executionAttempts).toHaveLength(1);
    expect(persisted.executionAttempts[0]).toMatchObject({ submissionId: "submission-1", status: "completed" });
    expect(harness.submitAgent).toHaveBeenCalledOnce();
    expect(harness.restartAgent).not.toHaveBeenCalled();
    for (const [input] of vi.mocked(harness.waitForSubmission).mock.calls) {
      expect(input.idempotencyKey).toBe(`execution:${samplingId}`);
    }
  });

  it("fails a stage whose terminal status stays unconfirmed for the bounded number of passes", async () => {
    const store = makeStore();
    const harness = makeHarness();
    vi.mocked(harness.submitAgent).mockResolvedValue(makeSubmission("running", "submission-1"));
    vi.mocked(harness.waitForSubmission).mockRejectedValue(socketClosed());
    vi.mocked(harness.inspectAgentOperation).mockRejectedValue(new Error("inspection service unavailable"));
    const reported = vi.fn();
    const runtime = createRuntime({ harness, store, sleep: async () => undefined, onError: reported });
    runtime.plans.execution = executionPlan({ retryPolicy: RETRY_TWO });
    const run = await runtime.submit(projectRequest("execution", "observation-exhausted"));
    for (let pass = 1; pass < OBSERVATION_MAX_PASSES; pass += 1) {
      await runtime.resume(run.runId);
      expect((await saved(store, run.samplingIds[0]!)).execution).toMatchObject({
        status: "retrying", observationPending: { passes: pass, lastError: expect.stringContaining("inspect error: inspection service unavailable") },
      });
    }
    await runtime.resume(run.runId);
    const persisted = await saved(store, run.samplingIds[0]!);
    expect(persisted.execution.status).toBe("failed");
    expect(persisted.execution.lastError).toContain(`could not be confirmed after ${OBSERVATION_MAX_PASSES} observation passes`);
    expect(persisted.execution).not.toHaveProperty("observationPending");
    expect(persisted.executionAttempts).toHaveLength(1);
    expect(harness.submitAgent).toHaveBeenCalledOnce();
    expect(harness.restartAgent).not.toHaveBeenCalled();
    expect(reported).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("inspection failed for sampling"),
    }), expect.objectContaining({ stage: "execution" }));
  });

  it("ends an MCP-accepted evaluation as succeeded with a resource refresh when its socket is lost", async () => {
    const store = makeStore();
    const harness = makeHarness();
    let evaluatorReady = false;
    mockReadiness(harness, (input) => input.handle.role !== "evaluator" || evaluatorReady);
    vi.mocked(harness.submitAgent).mockImplementation(async ({ handle }) => (
      handle.role === "evaluator" ? makeSubmission("running", "evaluation-submission") : makeSubmission("completed")
    ));
    const acceptedOutput = {
      status: "succeeded" as const, artifacts: [],
      trajectory: { trajectoryId: "trajectory-2", source: "evaluator" as const, path: "/eval/evaluation.jsonl" },
      structuredOutput: { path: "mcp:submit_evaluation", content: '{"score":8}', source: "submission" as const },
    };
    vi.mocked(harness.waitForSubmission).mockImplementation(async ({ handle }) => {
      if (handle.role !== "evaluator") return makeSubmission("completed");
      const [current] = await store.listEvaluations(handle.samplingId);
      await store.updateEvaluation({ ...current!, status: { status: "succeeded" }, output: acceptedOutput }, current!);
      throw socketClosed();
    });
    vi.mocked(harness.inspectAgentOperation).mockImplementation(async ({ handle }) => (
      handle.role === "evaluator" ? makeSubmission("running", "evaluation-submission") : makeSubmission("completed")
    ));
    const clock = testClock(START);
    const runtime = createRuntime({
      store, harness, sleep: async () => undefined, now: clock.now, plans: makePlans([makeSample("sample-1")]),
      results: { submission: { token: () => "t", read: async (id) => (await store.getEvaluation(id))?.output?.structuredOutput }, check: validScore },
    });
    const run = await runtime.submit(projectRequest("pipeline", "mcp-accepted-socket-lost"));

    await runtime.resume(run.runId);
    const evaluationId = (await runtime.getRun(run.runId)).evaluationIds[0]!;
    const first = await savedEvaluation(store, evaluationId);
    expect(first.status).toEqual({ status: "succeeded", resourcesPending: { deadline: expect.any(String), nextAttemptAt: expect.any(String) } });
    expect(first.output?.structuredOutput).toEqual(acceptedOutput.structuredOutput);
    expect(first.attempts[0]).toMatchObject({ submissionId: "evaluation-submission", status: "running" });
    expect((await runtime.getRun(run.runId)).status).toBe("succeeded");

    vi.mocked(harness.inspectAgentOperation).mockImplementation(async ({ handle }) => (
      makeSubmission("completed", handle.role === "evaluator" ? "evaluation-submission" : "submission-1")
    ));
    evaluatorReady = true;
    clock.advance(RESOURCE_CHECK_INTERVAL_MS);
    await runtime.resume(run.runId);
    const refreshed = await savedEvaluation(store, evaluationId);
    expect(refreshed.status).toEqual({ status: "succeeded" });
    expect(refreshed.output?.structuredOutput).toEqual(acceptedOutput.structuredOutput);
    expect(refreshed.attempts).toHaveLength(1);
    expect(refreshed.attempts[0]).toMatchObject({ status: "completed", completedAt: expect.any(String) });
    expect(refreshed.attempts[0]!.resources).toMatchObject({ status: "collected", summary: { finalized: true } });
    expect(vi.mocked(harness.submitAgent).mock.calls.filter(([call]) => call.handle.role === "evaluator")).toHaveLength(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });
});

describe("resumable Subject evidence export", () => {
  const files = { "/a.txt": "first", "/b.txt": "second" };
  const events = publicNativeRecords([1, 2, 3, 4, 5], { chatId: "chat-1", submissionId: "submission-1" });
  const recordBytes = (seq: number) => new TextEncoder().encode(`${JSON.stringify(events[seq - 1])}\n`).byteLength;
  const twoEventLimits = {
    ...DEFAULT_EVIDENCE_LIMITS,
    maxFileBytes: Math.max(recordBytes(1) + recordBytes(2), recordBytes(3) + recordBytes(4)),
  };
  const transient = (message: string) => Object.assign(new Error(message), { retryable: true });

  /** A clock that never repeats, so only persisted progress keeps `exportedAt` stable across passes. */
  const ticking = () => testClock(undefined, 1_000).now;

  /** Subject evidence whose file reads are recorded and may fail while `failing` holds the path. */
  function readsRecorded(harness: Harness, failing: Set<string>, reads: string[]) {
    vi.mocked(harness.exportEvidence).mockImplementation(async ({ handle, submissionId }) => {
      const base = exportedEvidence({ samplingId: handle.samplingId, chatId: handle.chatId, submissionId, files });
      return {
        ...base,
        async readFile(path) {
          reads.push(path);
          if (failing.has(path)) throw transient(`file ${path} unavailable`);
          return base.readFile(path);
        },
      };
    });
  }

  it("keeps evaluations queued and reads only the missing artifact on the next pass", async () => {
    const harness = makeHarness();
    const reads: string[] = [];
    const failing = new Set(["/b.txt"]);
    readsRecorded(harness, failing, reads);
    const store = makeStore();
    const runtime = createRuntime({ harness, store, sleep: async () => undefined, evidence: createEvidenceStore(createMemoryEvidenceBlobs(), ticking()) });
    const run = await runtime.submit(projectRequest("pipeline", "resume-artifacts"));

    await runtime.resume(run.runId);
    const pending = await runtime.getSampling(run.samplingIds[0]!);
    const submissionId = pending.executionAttempts[0]!.submissionId!;
    expect(pending.execution).toMatchObject({ status: "retrying", evidencePending: true });
    expect(pending.evidenceExport).toMatchObject({ submissionId, passes: 1, lastError: expect.stringContaining("file /b.txt unavailable") });
    expect(pending.evidenceExport!.progress!.artifacts).toEqual([
      { path: "/a.txt", size: 5, mediaType: "text/html", sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      { path: "/b.txt", size: 6, mediaType: "text/html" },
    ]);
    const [evaluationId] = (await runtime.getRun(run.runId)).evaluationIds;
    expect((await runtime.getEvaluation(evaluationId!)).status.status).toBe("queued");
    expect(harness.importEvidence).not.toHaveBeenCalled();
    expect(harness.exportEvidence).toHaveBeenCalledWith(expect.objectContaining({ submissionId }));

    failing.clear();
    reads.length = 0;
    await runtime.resume(run.runId);
    expect(reads).toEqual(["/b.txt"]);
    const done = await runtime.getSampling(run.samplingIds[0]!);
    expect(done.execution).toEqual({ status: "succeeded" });
    expect(done.evidence?.exportedAt).toBe(pending.evidenceExport!.progress!.exportedAt);
    expect(done).not.toHaveProperty("evidenceExport");
    expect(vi.mocked(harness.submitAgent).mock.calls.filter(([call]) => call.handle.role === "subject")).toHaveLength(1);
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("resumes the trajectory from the persisted cursor and stores the same bundle as one uninterrupted export", async () => {
    const harness = makeHarness();
    const cursors: number[] = [];
    let failAfter: number | undefined = 3;
    vi.mocked(harness.exportEvidence).mockImplementation(async ({ handle }) => {
      const base = exportedEvidence({ samplingId: handle.samplingId, chatId: handle.chatId, events });
      return {
        ...base,
        async* readTrajectory(afterSeq, throughSeq) {
          cursors.push(afterSeq);
          for await (const page of base.readTrajectory(afterSeq, throughSeq)) {
            if (failAfter !== undefined && page.records.some((record) => record.seq > failAfter!)) {
              const records = page.records.filter((record) => record.seq <= failAfter!);
              failAfter = undefined;
              yield { ...page, records, nextAfterSeq: records.at(-1)!.seq };
              throw transient("trajectory page unavailable");
            }
            yield page;
          }
        },
      };
    });
    const evidence = createEvidenceStore(createMemoryEvidenceBlobs(), ticking());
    const runtime = createRuntime({ harness, store: makeStore(), sleep: async () => undefined, evidence, evidenceLimits: twoEventLimits });
    const run = await runtime.submit(projectRequest("execution", "resume-trajectory"));

    await runtime.resume(run.runId);
    const pending = await runtime.getSampling(run.samplingIds[0]!);
    expect(pending.evidenceExport!.progress!.trajectory).toMatchObject({ afterSeq: 2, parts: [{ records: 2 }] });

    await runtime.resume(run.runId);
    expect(cursors).toEqual([0, 2]);
    const done = await runtime.getSampling(run.samplingIds[0]!);
    expect(done.execution).toEqual({ status: "succeeded" });
    const uninterrupted = await createEvidenceStore(createMemoryEvidenceBlobs(), () => done.evidence!.exportedAt).resume({
      evidence: exportedEvidence({ samplingId: done.samplingId, chatId: done.subjectChatId!, events }), limits: twoEventLimits,
    });
    expect(done.evidence).toEqual(uninterrupted);
    expect((await evidence.open(done.evidence!)).manifest.trajectory.parts.map((part) => part.records)).toEqual([2, 2, 1]);
  });

  it("finalizes the same evidence ID after a manifest write whose response was lost", async () => {
    const harness = makeHarness();
    const blobs = createMemoryEvidenceBlobs();
    const putManifest = blobs.putManifest.bind(blobs);
    let lose = true;
    blobs.putManifest = async (hex, bytes) => {
      await putManifest(hex, bytes);
      if (lose) {
        lose = false;
        throw transient("manifest response lost");
      }
    };
    const runtime = createRuntime({ harness, store: makeStore(), sleep: async () => undefined, evidence: createEvidenceStore(blobs, ticking()) });
    const run = await runtime.submit(projectRequest("execution", "resume-manifest"));

    await runtime.resume(run.runId);
    expect((await runtime.getSampling(run.samplingIds[0]!)).execution).toMatchObject({ status: "retrying", evidencePending: true });
    await runtime.resume(run.runId);
    const done = await runtime.getSampling(run.samplingIds[0]!);
    expect(done.execution).toEqual({ status: "succeeded" });
    expect([...blobs.manifests.keys()]).toEqual([done.evidence!.evidenceId.slice("sha256:".length)]);
  });

  it("fails the execution after a bounded number of passes, keeping its output and progress for recollection", async () => {
    const harness = makeHarness();
    const reads: string[] = [];
    const failing = new Set(["/b.txt"]);
    readsRecorded(harness, failing, reads);
    const store = makeStore();
    const runtime = createRuntime({ harness, store, sleep: async () => undefined, evidence: createEvidenceStore(createMemoryEvidenceBlobs(), ticking()) });
    const run = await runtime.submit(projectRequest("execution", "resume-budget"));

    for (let pass = 1; pass < EVIDENCE_EXPORT_MAX_PASSES; pass += 1) {
      await runtime.resume(run.runId);
      expect((await runtime.getSampling(run.samplingIds[0]!)).execution).toMatchObject({ status: "retrying", evidencePending: true });
    }
    await runtime.resume(run.runId);
    const failed = await saved(store, run.samplingIds[0]!);
    expect(failed.execution).toEqual({
      status: "failed",
      lastError: `evidence export failed after ${EVIDENCE_EXPORT_MAX_PASSES} passes: file /b.txt unavailable`,
    });
    expect(failed.artifacts).toEqual([{ artifactId: "artifact-1", kind: "project", path: "/eval/output" }]);
    expect(failed.evidence).toBeUndefined();
    expect(failed.evidenceExport).toMatchObject({ passes: EVIDENCE_EXPORT_MAX_PASSES, progress: { artifacts: [{ sha256: expect.any(String) }, {}] } });
    expect((await runtime.getRun(run.runId)).status).toBe("failed");
    expect(harness.exportEvidence).toHaveBeenCalledTimes(EVIDENCE_EXPORT_MAX_PASSES);
    expect(reads.filter((path) => path === "/a.txt")).toHaveLength(1);

    // A manual recollection resumes the same progress with a fresh pass budget.
    failing.clear();
    reads.length = 0;
    await store.updateSampling({ ...failed, execution: { status: "retrying", collectionPending: true } }, failed);
    await runtime.resume(run.runId);
    const recovered = await saved(store, run.samplingIds[0]!);
    expect(recovered.execution).toEqual({ status: "succeeded" });
    expect(reads).toEqual(["/b.txt"]);
    expect(recovered.evidence?.exportedAt).toBe(failed.evidenceExport!.progress!.exportedAt);
    expect(recovered).not.toHaveProperty("evidenceExport");
    expect(harness.submitAgent).toHaveBeenCalledOnce();
    expect(harness.restartAgent).not.toHaveBeenCalled();
  });

  it("restarts the pass budget on recollection, and never reuses progress of another Submission", async () => {
    const harness = makeHarness();
    const reads: string[] = [];
    const failing = new Set(["/b.txt"]);
    readsRecorded(harness, failing, reads);
    const store = makeStore();
    const runtime = createRuntime({ harness, store, sleep: async () => undefined, evidence: createEvidenceStore(createMemoryEvidenceBlobs(), ticking()) });
    const run = await runtime.submit(projectRequest("execution", "resume-other-submission"));
    for (let pass = 0; pass < EVIDENCE_EXPORT_MAX_PASSES; pass += 1) await runtime.resume(run.runId);
    const failed = await saved(store, run.samplingIds[0]!);
    expect(failed.execution.status).toBe("failed");

    await store.updateSampling({ ...failed, execution: { status: "retrying", collectionPending: true } }, failed);
    await runtime.resume(run.runId);
    const retried = await saved(store, run.samplingIds[0]!);
    expect(retried.execution).toMatchObject({ status: "retrying", evidencePending: true });
    expect(retried.evidenceExport?.passes).toBe(1);

    failing.clear();
    reads.length = 0;
    const foreign = { ...retried, evidenceExport: { ...retried.evidenceExport!, submissionId: "another-submission" } };
    await store.updateSampling(foreign, retried);
    await runtime.resume(run.runId);
    expect(reads.sort()).toEqual(["/a.txt", "/b.txt"]);
    expect((await saved(store, run.samplingIds[0]!)).execution).toEqual({ status: "succeeded" });
  });

  it("fails the execution at once on a native trajectory record too large for one evidence file", async () => {
    const harness = makeHarness();
    vi.mocked(harness.exportEvidence).mockImplementation(async ({ handle, submissionId }) => exportedEvidence({
      samplingId: handle.samplingId, chatId: handle.chatId, submissionId, files,
      events: [publicAssistantRecord(1, { chatId: handle.chatId, submissionId },
        "x".repeat(twoEventLimits.maxFileBytes))],
    }));
    const store = makeStore();
    const runtime = createRuntime({ harness, store, sleep: async () => undefined, evidenceLimits: twoEventLimits });
    const run = await runtime.submit(projectRequest("execution", "oversized-native-trajectory-record"));

    await runtime.resume(run.runId);
    const failed = await saved(store, run.samplingIds[0]!);
    expect(failed.execution.status).toBe("failed");
    expect(failed.execution.lastError).toMatch(/Trajectory record 1 is \d+ bytes, above the \d+-byte evidence file limit/u);
    expect(failed.evidence).toBeUndefined();
    expect(failed.evidenceExport).toMatchObject({ passes: 1 });
    expect(harness.exportEvidence).toHaveBeenCalledOnce();
  });
});
