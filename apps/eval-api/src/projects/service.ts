import type {
  AgentFramework,
  EvaluationOutputSchemaRef,
  EvaluationPlan,
  Project,
  RunHandle,
} from "@eval-platform/eval-contracts";
import type { EvalRunAdmission } from "@eval-platform/eval-runtime";
import {
  RuntimeAdmissionConflictError,
  RuntimeEntityNotFoundError,
  RuntimeInputError,
  RuntimeRecordConflictError,
  RuntimeRunIdentityConflictError,
  digestExecutionPlan,
  digestJson,
  normalizeEvaluationPlan,
  normalizeExecutionPlan,
} from "@eval-platform/eval-runtime";
import { createId } from "@eval-platform/eval-contracts";
import type { AgentConfigService, FrozenCopy } from "../agent-configs.js";
import {
  OutputSchemaNotFoundError,
  ProjectCreationKeyTakenError,
  ProjectIdempotencyConflictError,
} from "../db/errors.js";
import type { createOutputSchemaCatalog } from "../db/output-schemas.js";
import type { PostgresProjectStore, ProjectView, StoredProjectCreation } from "../db/project-store.js";
import type { EvaluationPlanBody, ProjectCreateBody } from "./schemas.js";
import { requireRunTargetCount } from "../limits.js";
import { bindProjectSamples } from "./snapshot.js";

type AgentPolicy = Pick<EvaluationPlanBody, "userAgentId" | "retryPolicy" | "timeoutMs">;

export interface ProjectCreation {
  readonly project: Project;
  /**
   * The creation's own first Run, admitted under the creation key, even after later Runs. Null when the
   * Project got other Runs before the creation admitted its first one.
   */
  readonly run: RunHandle | null;
}

/**
 * Bounds the creation loop: each pass re-reads the key after losing the key race, after the winner's Project
 * vanished, or after the creation-key Run was superseded during admission.
 */
const CREATION_ATTEMPTS = 3;
/** Bounds re-previews of a first Run whose plan changed between preview and admission. */
const FIRST_RUN_ATTEMPTS = 3;

/** A plan change means the Project is valid and being edited, so it is kept for a same-key replay. */
function compensates(error: unknown): boolean {
  return !(error instanceof RuntimeAdmissionConflictError && error.reason === "plan-changed");
}

/** The key identifies the request and the fingerprint its facts, so a retry with the same body matches. */
function fingerprintOf(body: ProjectCreateBody): Promise<string> {
  const { idempotencyKey: _key, ...facts } = body;
  return digestJson(facts);
}

/** The harness and optional retry policy shared by the execution and evaluation plan inputs. */
function agentPolicy<F extends AgentFramework>(ownerUserId: string, framework: F, userAgentId: string, body: AgentPolicy) {
  return {
    harness: {
      kind: "sp" as const, framework, agentConfig: { ownerUserId, userAgentId },
      ...(body.timeoutMs === undefined ? {} : { runtime: { timeoutMs: body.timeoutMs } }),
    },
    ...(body.retryPolicy === undefined ? {} : { retryPolicy: body.retryPolicy }),
  };
}

/**
 * Project creation and evaluation-plan replacement. SP copies are created outside the database
 * transaction, so every failure path removes the copies and rows that never became a usable Project.
 */
export function createProjectService(input: {
  readonly ownerUserId: string;
  readonly sourceBranch: string;
  readonly store: PostgresProjectStore;
  readonly outputSchemas: Pick<ReturnType<typeof createOutputSchemaCatalog>, "get">;
  readonly agentConfigs: Pick<AgentConfigService, "freeze" | "discard">;
  readonly admission: EvalRunAdmission;
}) {
  const { ownerUserId, store, agentConfigs, admission } = input;

  async function schemaRef(outputSchemaId: string): Promise<EvaluationOutputSchemaRef> {
    const record = await input.outputSchemas.get(outputSchemaId);
    if (!record) throw new OutputSchemaNotFoundError(outputSchemaId);
    return { outputSchemaId: record.outputSchemaId, digest: await digestJson(record.schema) };
  }

  function evaluationPlan(body: EvaluationPlanBody, copy: FrozenCopy, outputSchema: EvaluationOutputSchemaRef): EvaluationPlan {
    const { harness, ...retry } = agentPolicy(ownerUserId, "sp", copy.userAgentId, body);
    return normalizeEvaluationPlan({
      evaluationHarness: harness,
      evaluatorAgentConfig: copy.snapshot,
      evaluationConcurrency: body.evaluationConcurrency,
      ...retry,
      outputSchema,
    });
  }

  /** Builds the Dataset snapshots and one ProjectSample per distinct Data, in binding order. */
  async function snapshotSources(body: ProjectCreateBody, projectId: string) {
    const selected = await store.readSelection(body.datasets);
    const bound = bindProjectSamples({
      projectId, datasets: selected, samplingCountOf: (dataId) => body.samplingCounts?.[dataId] ?? body.samplingCount,
    });
    if (bound.samples.length === 0) throw new RuntimeInputError("Select at least one Data", "datasets");
    requireRunTargetCount(bound.samples.length);
    const selectedIds = new Set(bound.samples.map((sample) => sample.dataId));
    const unselected = Object.keys(body.samplingCounts ?? {}).find((dataId) => !selectedIds.has(dataId));
    if (unselected !== undefined) {
      throw new RuntimeInputError(`Data ${unselected} is not selected`, `samplingCounts.${unselected}`);
    }
    return bound;
  }

  /**
   * Admits the first Run under the creation key; a concurrent identical submission is replayed by Runtime.
   * Returns null when the key must be read again: the Project row is gone (compensated or soft-deleted), or
   * the creation-key Run was admitted meanwhile and already superseded.
   */
  async function admitFirstRun(project: Project, body: ProjectCreateBody): Promise<ProjectCreation | null> {
    const { projectId } = project;
    const { operation } = body.run;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { targets } = await admission.preview({ projectId, operation, selector: { all: true } });
        const run = await admission.submit({ idempotencyKey: body.idempotencyKey, projectId, operation, selector: { all: true }, targets });
        return { project, run };
      } catch (error) {
        if ((error instanceof RuntimeEntityNotFoundError && error.entity === "project")
          || error instanceof RuntimeRunIdentityConflictError) return null;
        if (!(error instanceof RuntimeAdmissionConflictError)) throw error;
        // Under the admission lock a Run committed first: the creation no longer owns the first Run.
        if (error.reason === "creation-superseded") return { project, run: null };
        // An evaluation-plan replacement landed between preview and admission; the Project is valid, so preview again.
        if (error.reason !== "plan-changed" || attempt >= FIRST_RUN_ATTEMPTS) throw error;
      }
    }
  }

  /**
   * Replays a creation already committed under the key. Its own first Run is returned when it exists;
   * a Project without any Run (the creator crashed before admission) gets its first Run now; a Project
   * that meanwhile has other Runs returns `run: null`. Null asks the caller to read the key again. A
   * replaying request never compensates: the Project belongs to the request that committed it.
   */
  async function replay(found: StoredProjectCreation, body: ProjectCreateBody, fingerprint: string): Promise<ProjectCreation | null> {
    if (found.deleted) throw new RuntimeEntityNotFoundError("project", found.project.projectId);
    if (found.fingerprint !== fingerprint) throw new ProjectIdempotencyConflictError();
    if (found.run) return { project: found.project, run: found.run };
    if (found.superseded) return { project: found.project, run: null };
    return admitFirstRun(found.project, body);
  }

  /** Returns null, for the caller to read the key again, when another request committed under it first or admission says so. */
  async function createOnce(body: ProjectCreateBody, fingerprint: string): Promise<ProjectCreation | null> {
    const projectId = createId();
    const { datasets, samples } = await snapshotSources(body, projectId);
    const evaluationInput = body.evaluation
      ? { body: body.evaluation, outputSchema: await schemaRef(body.evaluation.outputSchemaId) }
      : null;
    const project: Project = {
      projectId, ownerUserId, name: body.name,
      ...(body.description === undefined ? {} : { description: body.description }),
      sourceBranch: input.sourceBranch, createdAt: new Date().toISOString(),
    };
    const copies: string[] = [];
    try {
      const subject = await agentConfigs.freeze(body.execution.userAgentId);
      copies.push(subject.userAgentId);
      let evaluation: { readonly copy: FrozenCopy; readonly plan: EvaluationPlan } | null = null;
      if (evaluationInput) {
        const copy = await agentConfigs.freeze(evaluationInput.body.userAgentId);
        copies.push(copy.userAgentId);
        evaluation = { copy, plan: evaluationPlan(evaluationInput.body, copy, evaluationInput.outputSchema) };
      }
      const execution = normalizeExecutionPlan({
        ...agentPolicy(ownerUserId, body.execution.framework, subject.userAgentId, body.execution),
        subjectAgentConfig: subject.snapshot,
        executionConcurrency: body.execution.executionConcurrency,
      });
      await store.create({
        project,
        datasets,
        samples,
        execution: { plan: execution, digest: await digestExecutionPlan({ execution, datasets, samples }) },
        evaluation: evaluation && { plan: evaluation.plan, digest: await digestJson(evaluation.plan) },
        agentConfigs: [
          { userAgentId: subject.userAgentId, role: "subject", snapshot: subject.snapshot },
          ...(evaluation ? [{ userAgentId: evaluation.copy.userAgentId, role: "evaluator" as const, snapshot: evaluation.copy.snapshot }] : []),
        ],
        creation: { key: body.idempotencyKey, fingerprint },
      });
    } catch (error) {
      await agentConfigs.discard(copies);
      if (error instanceof ProjectCreationKeyTakenError) return null;
      throw error;
    }
    try {
      return await admitFirstRun(project, body);
    } catch (error) {
      if (compensates(error)) await compensate(projectId, error);
      throw error;
    }
  }

  /**
   * Only the request that committed a Project compensates it, and only while it has no Run and was not
   * soft-deleted (the Store keeps those). A failed compensation can leave a visible Run-less Project, so it
   * is reported together with the original failure.
   */
  async function compensate(projectId: string, failure: unknown): Promise<void> {
    let removed: string[];
    try {
      removed = await store.deleteUnrun(projectId);
    } catch (compensationError) {
      throw new AggregateError([failure, compensationError], "First Run admission failed and the Project could not be removed");
    }
    await agentConfigs.discard(removed);
  }

  return {
    list: () => store.list(),
    exists: (projectId: string) => store.exists(projectId),
    get: (projectId: string) => store.get(projectId),
    delete: (projectId: string) => store.softDelete(projectId),

    /**
     * Snapshot, freeze, persist and admit the first Run; nothing remains visible when any step fails.
     * The owner-scoped `idempotencyKey` replays an earlier creation with the same body.
     */
    async create(body: ProjectCreateBody): Promise<ProjectCreation> {
      // Checked here, before any SP copy is frozen, so an invalid body creates nothing; Runtime admission
      // enforces the same rule as evaluation-plan-required.
      if (body.run.operation === "pipeline" && body.evaluation === undefined) {
        throw new RuntimeInputError("A pipeline Run requires an evaluation plan", "evaluation");
      }
      const fingerprint = await fingerprintOf(body);
      for (let attempt = 1; attempt <= CREATION_ATTEMPTS; attempt += 1) {
        const found = await store.findCreation(body.idempotencyKey);
        const created = found ? await replay(found, body, fingerprint) : await createOnce(body, fingerprint);
        if (created) return created;
      }
      throw new RuntimeRecordConflictError("Project creation kept racing the same idempotency key");
    },

    /** The only Project configuration write: replace the unlocked evaluation plan as a whole. */
    async replaceEvaluationPlan(projectId: string, body: EvaluationPlanBody): Promise<ProjectView> {
      await store.requireEvaluationPlanEditable(projectId);
      const outputSchema = await schemaRef(body.outputSchemaId);
      const evaluator = await agentConfigs.freeze(body.userAgentId);
      let retired: string[];
      try {
        const plan = evaluationPlan(body, evaluator, outputSchema);
        retired = await store.replaceEvaluationPlan(projectId, {
          plan, digest: await digestJson(plan),
          agentConfig: { userAgentId: evaluator.userAgentId, role: "evaluator", snapshot: evaluator.snapshot },
        });
      } catch (error) {
        await agentConfigs.discard([evaluator.userAgentId]);
        throw error;
      }
      await agentConfigs.discard(retired);
      const view = await store.get(projectId);
      if (!view) throw new RuntimeEntityNotFoundError("project", projectId);
      return view;
    },
  };
}

export type ProjectService = ReturnType<typeof createProjectService>;
