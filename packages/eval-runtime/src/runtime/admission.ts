import type {
  AgentConfigRef,
  EvaluationRecord,
  ProjectEvaluation,
  ProjectPlan,
  RunHandle,
  RunOperation,
  RunPlanDigests,
  RunReplayRequest,
  RunRequest,
  RunTargetSelector,
  RunTargets,
  Sampling,
} from "@eval-platform/eval-contracts";
import { createId, equalJson, RUN_OPERATIONS } from "@eval-platform/eval-contracts";
import { digestJson, phasesOf, planProjectSampleIds } from "../plan/index.js";
import {
  RuntimeAdmissionConflictError,
  RuntimeEntityNotFoundError,
  RuntimeInputError,
  RuntimeRunIdentityConflictError,
} from "./errors.js";
import { requireEvaluationPrompt } from "./evaluation.js";
import { requireDistinctIds, requireIdentifier, requireObject } from "./input.js";
import type {
  EvalRunAdmission,
  EvalRunAdmissionDependencies,
  ProjectPlanReader,
  ProjectSample,
  RunPreview,
  RunPreviewRequest,
} from "./model.js";
import { RunRecords } from "./records.js";
import type { RuntimeFirstRunProof, RuntimeRunPlanDigests, RuntimeRunRecord, RuntimeStore, SamplingState } from "./store.js";
import { expandRunTargets } from "./targets.js";

/** The immutable caller intent bound to one idempotency key. */
type RunRequestFacts = Omit<RunRequest, "idempotencyKey">;

/** A Project plan that may run the requested operation; evaluating operations carry its evaluation. */
type AdmissionPlan =
  | { readonly operation: "execution"; readonly plan: ProjectPlan }
  | { readonly operation: "pipeline" | "evaluation"; readonly plan: ProjectPlan; readonly evaluation: ProjectEvaluation };

/** Validated targets with the current facts they replace or evaluate. */
interface RunWork {
  /** Target ProjectSamples in target order. */
  readonly samples: readonly ProjectSample[];
  /** Current Samplings of the target ProjectSamples (execution/pipeline only). */
  readonly replaced: readonly SamplingState[];
  /** Target Samplings in target order. */
  readonly samplings: readonly SamplingState[];
}

const IDENTITY_CONFLICT = "idempotency key is already bound to different Run facts";
const SELECTOR_KEYS = ["datasetIds", "projectSampleIds", "samplingIds"] as const;

export function requireSourceCommit(sourceCommit: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit)) {
    throw new TypeError("sourceCommit must be a full lowercase Git commit hash");
  }
  return sourceCommit;
}

export class RunAdmission implements EvalRunAdmission {
  readonly #sourceCommit: string;
  readonly #plans: ProjectPlanReader;
  readonly #store: RuntimeStore;
  readonly #idFactory: () => string;
  readonly #records: RunRecords;
  readonly #pending = new Map<string, {
    readonly facts: RunRequestFacts;
    readonly creationFingerprint: string | undefined;
    readonly promise: Promise<RunHandle>;
  }>();

  constructor(dependencies: EvalRunAdmissionDependencies) {
    this.#sourceCommit = requireSourceCommit(dependencies.sourceCommit);
    this.#plans = dependencies.plans;
    this.#store = dependencies.store;
    this.#idFactory = dependencies.idFactory ?? createId;
    this.#records = new RunRecords(dependencies.store, dependencies.plans);
  }

  /** Expand a selector inside the Project snapshot into the fixed targets a submit must carry. */
  async preview(request: RunPreviewRequest): Promise<RunPreview> {
    const { projectId, operation, selector } = requirePreviewRequest(request);
    const admitted = await this.#plan(projectId, operation);
    const { plan } = admitted;
    const targets = await expandRunTargets(plan, operation, selector, this.#store);
    const { samples, replaced, samplings } = await this.#work(plan, operation, targets);
    const executes = operation !== "evaluation";
    const newSamplingCount = executes
      ? samples.reduce((count, sample) => count + sample.samplingCount, 0) + samplings.length
      : 0;
    return {
      projectId,
      operation,
      selector,
      targets,
      replacedSamplingCount: executes ? replaced.length + samplings.length : 0,
      newSamplingCount,
      evaluationCount: operation === "pipeline" ? newSamplingCount : operation === "evaluation" ? samplings.length : 0,
      executionPlanDigest: plan.executionPlanDigest,
      evaluationPlanDigest: admitted.operation === "execution" ? null : admitted.evaluation.digest,
    };
  }

  /** Coalesce concurrent same-key requests, then replay an existing Run or admit the submitted targets. */
  async submit(request: RunRequest, firstRun?: RuntimeFirstRunProof): Promise<RunHandle> {
    const { idempotencyKey, ...facts } = requireRunRequest(request, true);
    const key = JSON.stringify([facts.projectId, idempotencyKey]);
    const creationFingerprint = firstRun?.creationFingerprint;
    const proof = firstRun === undefined ? undefined : { creationFingerprint: firstRun.creationFingerprint };
    const pending = this.#pending.get(key);
    if (pending) {
      // Never let an ordinary submit join a proven ProjectService first-Run call (or vice versa).
      if (!equalJson(pending.facts, facts) || pending.creationFingerprint !== creationFingerprint) {
        throw new RuntimeRunIdentityConflictError(IDENTITY_CONFLICT);
      }
      return pending.promise.then(copyHandle);
    }
    const promise = Promise.resolve().then(() => this.#persist(idempotencyKey, facts, proof));
    this.#pending.set(key, { facts, creationFingerprint, promise });
    const clear = () => {
      if (this.#pending.get(key)?.promise === promise) this.#pending.delete(key);
    };
    void promise.then(clear, clear);
    return promise;
  }

  /** Read-only stored-Run lookup, including a legacy request with no expected digests. */
  async replay(request: RunReplayRequest): Promise<RunHandle | null> {
    const { idempotencyKey, ...facts } = requireRunRequest(request, false);
    return this.#replayStored(idempotencyKey, facts);
  }

  async #replayStored(idempotencyKey: string, facts: Omit<RunReplayRequest, "idempotencyKey">): Promise<RunHandle | null> {
    const existing = await this.#store.findRunByIdempotencyKey(facts.projectId, idempotencyKey);
    if (!existing) return null;
    if (existing.projectId !== facts.projectId || existing.requestIdentity.idempotencyKey !== idempotencyKey
      || existing.operation !== facts.operation || !equalJson(existing.selector, facts.selector)
      || !equalJson(existing.targets, facts.targets)
      || (facts.expectedPlanDigests !== undefined && !equalJson(facts.expectedPlanDigests, existing.planDigests))
      || existing.requestIdentity.requestFingerprint !== await requestFingerprint(facts, existing.planDigests)) {
      throw new RuntimeRunIdentityConflictError(IDENTITY_CONFLICT);
    }
    return copyHandle(existing);
  }

  async #persist(idempotencyKey: string, facts: RunRequestFacts, firstRun?: RuntimeFirstRunProof): Promise<RunHandle> {
    const existing = await this.#replayStored(idempotencyKey, facts);
    if (existing) return existing;

    const { projectId, operation, targets } = facts;
    const admitted = await this.#plan(projectId, operation);
    const { plan } = admitted;
    if (!equalJson(planDigestsOf(admitted), facts.expectedPlanDigests)) {
      throw new RuntimeAdmissionConflictError("plan-changed", "Project plan changed after the Run was previewed");
    }
    // The caller's preview digest, never a freshly substituted plan, is the identity stored on the Run.
    const planDigests = facts.expectedPlanDigests;
    const { samples, replaced, samplings } = await this.#work(plan, operation, targets);
    const subjectAgent = plan.execution.harness.agentConfig;
    const created = operation === "evaluation" ? [] : [
      ...samples.flatMap((sample) => Array.from(
        { length: sample.samplingCount },
        () => this.#createSampling(projectId, sample.projectSampleId, subjectAgent),
      )),
      ...samplings.map((sampling) => this.#createSampling(projectId, sampling.projectSampleId, subjectAgent)),
    ];
    const runSamplings = operation === "evaluation" ? samplings : created;
    const evaluations = admitted.operation === "execution" ? [] : runSamplings.map(({ samplingId }) => (
      this.#createEvaluation(samplingId, admitted.evaluation.plan.evaluationHarness.agentConfig)
    ));
    const run: RuntimeRunRecord = {
      runId: this.#idFactory(),
      projectId,
      sourceCommit: this.#sourceCommit,
      operation,
      phases: phasesOf(operation),
      selector: facts.selector,
      targets,
      samplingIds: runSamplings.map(({ samplingId }) => samplingId),
      evaluationIds: evaluations.map(({ evaluationId }) => evaluationId),
      planDigests,
      requestIdentity: { idempotencyKey, requestFingerprint: await requestFingerprint(facts, planDigests) },
    };
    const admission = await this.#store.admitRun({
      run, ...(firstRun === undefined ? {} : { firstRun }),
      replacedSamplingIds: operation === "evaluation" ? [] : [...replaced, ...samplings].map(({ samplingId }) => samplingId),
      samplings: created,
      evaluations,
    });
    return copyHandle(admission.run);
  }

  async #plan(projectId: string, operation: RunOperation): Promise<AdmissionPlan> {
    const plan = await this.#plans.getProjectPlan(projectId);
    if (!plan) throw new RuntimeEntityNotFoundError("project", projectId);
    if (operation === "execution") return { operation, plan };
    const { evaluation } = plan;
    if (!evaluation) {
      throw new RuntimeAdmissionConflictError(
        "evaluation-plan-required",
        `Project ${projectId} needs an evaluation plan before ${operation}`,
      );
    }
    return { operation, plan, evaluation };
  }

  /** Validate fixed targets against the plan and current Samplings without re-expanding a selector. */
  async #work(plan: ProjectPlan, operation: RunOperation, targets: RunTargets): Promise<RunWork> {
    const { projectId } = plan.project;
    if (targets.projectSampleIds.length + targets.samplingIds.length === 0) {
      throw new RuntimeAdmissionConflictError("empty-targets", `Run of Project ${projectId} selects no work`);
    }
    if (operation === "evaluation" && targets.projectSampleIds.length > 0) {
      throw new RuntimeInputError("evaluation targets must list Samplings only", "targets.projectSampleIds");
    }
    const known = new Set(planProjectSampleIds(plan));
    for (const projectSampleId of targets.projectSampleIds) {
      if (!known.has(projectSampleId)) throw new RuntimeEntityNotFoundError("project-sample", projectSampleId);
    }
    const replacedBySample = new Set(targets.projectSampleIds);
    const samplings = await this.#projectSamplings(projectId, targets.samplingIds);
    for (const sampling of samplings) {
      if (replacedBySample.has(sampling.projectSampleId)) {
        throw new RuntimeInputError(
          `Sampling ${sampling.samplingId} is already replaced by ProjectSample ${sampling.projectSampleId}`,
          "targets.samplingIds",
        );
      }
      if (operation === "evaluation" && sampling.execution.status !== "succeeded") {
        throw new RuntimeAdmissionConflictError(
          "sampling-unavailable",
          `Sampling ${sampling.samplingId} has no successful execution in Project ${projectId}`,
        );
      }
    }
    const involved = await this.#records.projectSamples(projectId, [...new Set([
      ...targets.projectSampleIds,
      ...samplings.map(({ projectSampleId }) => projectSampleId),
    ])]);
    if (operation !== "execution") for (const sample of involved) requireEvaluationPrompt(sample);
    const samples = involved.slice(0, targets.projectSampleIds.length);
    const replaced = operation === "evaluation" || samples.length === 0
      ? []
      : await this.#store.listProjectSamplings(projectId, targets.projectSampleIds);
    return { samples, replaced, samplings };
  }

  /** Current Samplings of this Project; a missing or foreign Sampling is unknown to the caller. */
  async #projectSamplings(projectId: string, samplingIds: readonly string[]): Promise<readonly SamplingState[]> {
    if (samplingIds.length === 0) return [];
    const samplings = await this.#records.samplings(samplingIds);
    for (const sampling of samplings) {
      if (sampling.projectId !== projectId) throw new RuntimeEntityNotFoundError("sampling", sampling.samplingId);
    }
    return samplings;
  }

  #createSampling(projectId: string, projectSampleId: string, subjectAgent: AgentConfigRef): Sampling {
    return {
      samplingId: this.#idFactory(),
      projectId,
      projectSampleId,
      execution: { status: "queued" },
      subjectAgent,
      executionAttempts: [],
    };
  }

  #createEvaluation(samplingId: string, evaluator: AgentConfigRef): EvaluationRecord {
    return {
      evaluationId: this.#idFactory(),
      samplingId,
      evaluator,
      status: { status: "queued" },
      attempts: [],
    };
  }
}

function planDigestsOf(admitted: AdmissionPlan): RuntimeRunPlanDigests {
  const execution = admitted.plan.executionPlanDigest;
  return admitted.operation === "execution" ? { execution } : { execution, evaluation: admitted.evaluation.digest };
}

function requirePreviewRequest(request: RunPreviewRequest): RunPreviewRequest {
  requireObject(request, "request");
  requireIdentifier(request.projectId, "projectId");
  if (!(RUN_OPERATIONS as readonly unknown[]).includes(request.operation)) {
    throw new RuntimeInputError(`operation must be one of ${RUN_OPERATIONS.join(", ")}`, "operation");
  }
  return { projectId: request.projectId, operation: request.operation, selector: requireSelector(request.selector) };
}

function requireRunRequest(request: RunReplayRequest, required: true): RunRequest;
function requireRunRequest(request: RunReplayRequest, required: false): RunReplayRequest;
function requireRunRequest(request: RunReplayRequest, required: boolean): RunReplayRequest {
  requireObject(request, "request");
  requireIdentifier(request.idempotencyKey, "idempotencyKey");
  const preview = requirePreviewRequest(request);
  const expectedPlanDigests = request.expectedPlanDigests === undefined
    ? undefined : requirePlanDigests(request.expectedPlanDigests, preview.operation);
  if (required && expectedPlanDigests === undefined) {
    throw new RuntimeInputError("expectedPlanDigests is required to submit a Run", "expectedPlanDigests");
  }
  return {
    idempotencyKey: request.idempotencyKey, ...preview, targets: requireTargets(request.targets),
    ...(expectedPlanDigests === undefined ? {} : { expectedPlanDigests }),
  };
}

function requirePlanDigests(digests: RunPlanDigests, operation: RunOperation): RunPlanDigests {
  requireObject(digests, "expectedPlanDigests");
  if (Object.keys(digests).some((key) => key !== "execution" && key !== "evaluation")) {
    throw new RuntimeInputError("expectedPlanDigests contains an unknown field", "expectedPlanDigests");
  }
  const sha256 = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
      throw new RuntimeInputError(`${field} must be a lowercase SHA-256 digest`, field);
    }
    return value;
  };
  const execution = sha256(digests.execution, "expectedPlanDigests.execution");
  if (operation === "execution") {
    if (digests.evaluation !== undefined) {
      throw new RuntimeInputError("execution cannot have an evaluation digest", "expectedPlanDigests.evaluation");
    }
    return { execution };
  }
  return { execution, evaluation: sha256(digests.evaluation, "expectedPlanDigests.evaluation") };
}

function requireSelector(selector: RunTargetSelector): RunTargetSelector {
  requireObject(selector, "selector");
  if (selector.all !== undefined && selector.all !== true) throw new RuntimeInputError("selector.all must be true", "selector.all");
  let copy: RunTargetSelector = selector.all ? { all: true } : {};
  for (const key of SELECTOR_KEYS) {
    if (selector[key] !== undefined) copy = { ...copy, [key]: requireIds(selector[key], `selector.${key}`) };
  }
  if (!copy.all && !SELECTOR_KEYS.some((key) => (copy[key]?.length ?? 0) > 0)) {
    throw new RuntimeInputError("selector must select at least one target", "selector");
  }
  return copy;
}

function requireTargets(targets: RunTargets): RunTargets {
  requireObject(targets, "targets");
  return {
    projectSampleIds: requireIds(targets.projectSampleIds, "targets.projectSampleIds"),
    samplingIds: requireIds(targets.samplingIds, "targets.samplingIds"),
  };
}

function requireIds(ids: unknown, field: string): string[] {
  if (!Array.isArray(ids)) throw new RuntimeInputError(`${field} must be an array`, field);
  for (const id of ids) requireIdentifier(id, field);
  requireDistinctIds(ids, field);
  return [...ids];
}

function requestFingerprint(facts: Omit<RunReplayRequest, "idempotencyKey">, planDigests: RuntimeRunPlanDigests): Promise<string> {
  const { projectId, operation, selector, targets } = facts;
  return digestJson({ projectId, operation, selector, targets, planDigests });
}

function copyHandle(run: RunHandle): RunHandle {
  return { runId: run.runId, samplingIds: [...run.samplingIds] };
}
