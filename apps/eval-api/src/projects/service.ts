import type {
  AgentFramework,
  EvaluationOutputSchemaRef,
  EvaluationPlan,
  Project,
  RetryPolicy,
  RunHandle,
} from "@eval-platform/eval-contracts";
import type { EvalRunAdmission } from "@eval-platform/eval-runtime";
import {
  RuntimeEntityNotFoundError,
  RuntimeInputError,
  digestExecutionPlan,
  digestJson,
  normalizeEvaluationPlan,
  normalizeExecutionPlan,
} from "@eval-platform/eval-runtime";
import type { AgentConfigService, FrozenCopy } from "../agent-configs.js";
import {
  OutputSchemaNotFoundError,
  ProjectCreationKeyTakenError,
  ProjectIdempotencyConflictError,
  requireRunTargetCount,
} from "../db/errors.js";
import type { createOutputSchemaCatalog } from "../db/output-schemas.js";
import type { DatasetSelection, PostgresProjectStore, ProjectView } from "../db/project-store.js";
import { bindProjectSamples } from "./snapshot.js";

interface AgentPolicy {
  readonly userAgentId: string;
  readonly retryPolicy?: RetryPolicy;
  readonly timeoutMs?: number;
}

export interface ExecutionPlanBody extends AgentPolicy {
  readonly framework: AgentFramework;
  readonly executionConcurrency: number;
}

export interface EvaluationPlanBody extends AgentPolicy {
  readonly evaluationConcurrency: number;
  readonly outputSchemaId: string;
}

export interface ProjectCreateBody {
  /** Owner-scoped creation identity; the first Run is admitted under the same key. */
  readonly idempotencyKey: string;
  readonly name: string;
  readonly description?: string;
  readonly datasets: readonly DatasetSelection[];
  /** Default Sampling count of every selected Data. */
  readonly samplingCount: number;
  /** Per-Data overrides; every key must be a selected Data. */
  readonly samplingCounts?: Readonly<Record<string, number>>;
  readonly execution: ExecutionPlanBody;
  readonly evaluation?: EvaluationPlanBody;
  /** The first Run; a new Project has no successful Sampling, so it cannot be evaluation-only. */
  readonly run: { readonly operation: "execution" | "pipeline" };
}

export interface ProjectCreation {
  readonly project: Project;
  /**
   * The creation's own first Run, admitted under the creation key, even after later Runs. Null when a
   * replay finds the Project already has other Runs but never admitted its first one.
   */
  readonly run: RunHandle | null;
}

/** Concurrent creations losing the key race replay the winner; this bounds rare winner compensation loops. */
const CREATION_ATTEMPTS = 3;

/** Digest of the validated body without its key. */
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

  /** Admits the first Run under the creation key; a concurrent identical submission is replayed by Runtime. */
  async function admitFirstRun(project: Project, body: ProjectCreateBody): Promise<ProjectCreation> {
    const { projectId } = project;
    const { operation } = body.run;
    const { targets } = await admission.preview({ projectId, operation, selector: { all: true } });
    const run = await admission.submit({ idempotencyKey: body.idempotencyKey, projectId, operation, selector: { all: true }, targets });
    return { project, run };
  }

  /**
   * Replays a creation already committed under the key. Its own first Run is returned when it exists;
   * a Project without any Run (the creator crashed before admission) gets its first Run now; a Project
   * that meanwhile has other Runs returns `run: null`. A replaying request never compensates: the
   * Project belongs to the request that committed it.
   */
  async function replay(body: ProjectCreateBody, fingerprint: string): Promise<ProjectCreation | null> {
    const found = await store.findCreation(body.idempotencyKey);
    if (!found) return null;
    if (found.deleted) throw new RuntimeEntityNotFoundError("project", found.project.projectId);
    if (found.fingerprint !== fingerprint) throw new ProjectIdempotencyConflictError();
    if (found.run) return { project: found.project, run: found.run };
    return found.hasRun ? { project: found.project, run: null } : admitFirstRun(found.project, body);
  }

  async function createOnce(body: ProjectCreateBody, fingerprint: string): Promise<ProjectCreation> {
    const projectId = crypto.randomUUID();
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
      throw error;
    }
    try {
      return await admitFirstRun(project, body);
    } catch (error) {
      await compensate(projectId, error);
      throw error;
    }
  }

  /**
   * Only the request that committed a Project compensates it, and only while it has no Run. A failed
   * compensation can leave a visible Run-less Project, so it is reported together with the original failure.
   */
  async function compensate(projectId: string, failure: unknown): Promise<void> {
    let removed: string[] | null;
    try {
      removed = await store.deleteUnrun(projectId);
    } catch (compensationError) {
      throw new AggregateError([failure, compensationError], "First Run admission failed and the Project could not be removed");
    }
    if (removed) await agentConfigs.discard(removed);
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
      if (body.run.operation === "pipeline" && body.evaluation === undefined) {
        throw new RuntimeInputError("A pipeline Run requires an evaluation plan", "evaluation");
      }
      const fingerprint = await fingerprintOf(body);
      for (let attempt = 1; ; attempt += 1) {
        const replayed = await replay(body, fingerprint);
        if (replayed) return replayed;
        try {
          return await createOnce(body, fingerprint);
        } catch (error) {
          if (!(error instanceof ProjectCreationKeyTakenError) || attempt >= CREATION_ATTEMPTS) throw error;
        }
      }
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
