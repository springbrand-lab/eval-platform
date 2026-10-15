import type {
  AgentConfigRef,
  EvaluationRecord,
  ProjectEvaluation,
  ProjectPlan,
  RunHandle,
  RunOperation,
  RunRequest,
  RunTargetSelector,
  RunTargets,
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
import type { RuntimeRunPlanDigests, RuntimeRunRecord, RuntimeStore, SamplingState } from "./store.js";

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
  readonly #pending = new Map<string, { readonly facts: RunRequestFacts; readonly promise: Promise<RunHandle> }>();

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
    const targets = await this.#expand(plan, operation, selector);
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
  async submit(request: RunRequest): Promise<RunHandle> {
    const { idempotencyKey, ...facts } = requireRunRequest(request);
    const key = JSON.stringify([facts.projectId, idempotencyKey]);
    const pending = this.#pending.get(key);
    if (pending) {
      if (!equalJson(pending.facts, facts)) throw new RuntimeRunIdentityConflictError(IDENTITY_CONFLICT);
      return pending.promise.then(copyHandle);
    }
    const promise = Promise.resolve().then(() => this.#persist(idempotencyKey, facts));
    this.#pending.set(key, { facts, promise });
    const clear = () => {
      if (this.#pending.get(key)?.promise === promise) this.#pending.delete(key);
    };
    void promise.then(clear, clear);
    return promise;
  }

  async #persist(idempotencyKey: string, facts: RunRequestFacts): Promise<RunHandle> {
    const existing = await this.#store.findRunByIdempotencyKey(facts.projectId, idempotencyKey);
    if (existing) {
      if (existing.requestIdentity.requestFingerprint !== await requestFingerprint(facts, existing.planDigests)) {
        throw new RuntimeRunIdentityConflictError(IDENTITY_CONFLICT);
      }
      return copyHandle(existing);
    }

    const { projectId, operation, targets } = facts;
    const admitted = await this.#plan(projectId, operation);
    const { plan } = admitted;
    const planDigests = planDigestsOf(admitted);
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
      run,
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

  /** Expand inside the Project snapshot; evaluation keeps only successful current Samplings. */
  async #expand(plan: ProjectPlan, operation: RunOperation, selector: RunTargetSelector): Promise<RunTargets> {
    const { projectId } = plan.project;
    const bound = planProjectSampleIds(plan);
    const selected = new Set<string>(selector.all ? bound : []);
    for (const datasetId of selector.datasetIds ?? []) {
      const dataset = plan.datasets.find((item) => item.datasetId === datasetId);
      if (!dataset) throw new RuntimeEntityNotFoundError("dataset", datasetId);
      for (const projectSampleId of dataset.projectSampleIds) selected.add(projectSampleId);
    }
    const known = new Set(bound);
    for (const projectSampleId of selector.projectSampleIds ?? []) {
      if (!known.has(projectSampleId)) throw new RuntimeEntityNotFoundError("project-sample", projectSampleId);
      selected.add(projectSampleId);
    }
    const explicit = await this.#projectSamplings(projectId, selector.samplingIds ?? []);
    if (operation !== "evaluation") {
      return {
        projectSampleIds: [...selected],
        samplingIds: explicit.filter((sampling) => !selected.has(sampling.projectSampleId)).map(({ samplingId }) => samplingId),
      };
    }
    const expanded = selected.size === 0 ? [] : await this.#store.listProjectSamplings(projectId, [...selected]);
    return {
      projectSampleIds: [],
      samplingIds: [...new Set([
        ...expanded.filter(({ execution }) => execution.status === "succeeded"),
        ...explicit,
      ].map(({ samplingId }) => samplingId))],
    };
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

  #createSampling(projectId: string, projectSampleId: string, subjectAgent: AgentConfigRef): SamplingState {
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

function requireRunRequest(request: RunRequest): RunRequest {
  requireObject(request, "request");
  requireIdentifier(request.idempotencyKey, "idempotencyKey");
  return { idempotencyKey: request.idempotencyKey, ...requirePreviewRequest(request), targets: requireTargets(request.targets) };
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

function requestFingerprint(facts: RunRequestFacts, planDigests: RuntimeRunPlanDigests): Promise<string> {
  const { projectId, operation, selector, targets } = facts;
  return digestJson({ projectId, operation, selector, targets, planDigests });
}

function copyHandle(run: RunHandle): RunHandle {
  return { runId: run.runId, samplingIds: [...run.samplingIds] };
}
