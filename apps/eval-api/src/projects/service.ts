import type {
  AgentFramework,
  EvaluationOutputSchemaRef,
  EvaluationPlan,
  Project,
  ProjectDatasetSnapshot,
  RetryPolicy,
  RunHandle,
} from "@eval-platform/eval-contracts";
import type { EvalRunAdmission, ProjectSample } from "@eval-platform/eval-runtime";
import {
  RuntimeEntityNotFoundError,
  digestEvaluationOutputSchema,
  digestEvaluationPlan,
  digestJson,
  digestExecutionPlan,
  normalizeEvaluationPlan,
  normalizeExecutionPlan,
} from "@eval-platform/eval-runtime";
import type { AgentConfigService, FrozenCopy } from "../agent-configs.js";
import {
  OutputSchemaNotFoundError,
  ProjectCreationKeyTakenError,
  ProjectIdempotencyConflictError,
  ProjectInputError,
} from "../db/errors.js";
import type { createOutputSchemaCatalog } from "../db/output-schemas.js";
import type { DatasetSelection, PostgresProjectStore, ProjectView } from "../db/project-store.js";
import { RUN_TARGET_IDS } from "../limits.js";

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
  readonly run: RunHandle;
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
    return { outputSchemaId: record.outputSchemaId, digest: await digestEvaluationOutputSchema(record.schema) };
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
    const samples = new Map<string, ProjectSample & { datasetIds: string[] }>();
    const datasets: ProjectDatasetSnapshot[] = selected.map(({ dataset, data }) => ({
      ...dataset,
      projectSampleIds: data.map((record) => {
        let sample = samples.get(record.dataId);
        if (!sample) {
          sample = {
            projectSampleId: crypto.randomUUID(), projectId, dataId: record.dataId, datasetIds: [],
            samplingCount: body.samplingCounts?.[record.dataId] ?? body.samplingCount, data: record,
          };
          samples.set(record.dataId, sample);
        }
        sample.datasetIds.push(dataset.datasetId);
        return sample.projectSampleId;
      }),
    }));
    if (samples.size === 0) throw new ProjectInputError("Select at least one Data", "datasets");
    if (samples.size > RUN_TARGET_IDS) throw new ProjectInputError(`Select at most ${RUN_TARGET_IDS} Data`, "datasets");
    const unselected = Object.keys(body.samplingCounts ?? {}).find((dataId) => !samples.has(dataId));
    if (unselected !== undefined) {
      throw new ProjectInputError(`Data ${unselected} is not selected`, `samplingCounts.${unselected}`);
    }
    return { datasets, samples: [...samples.values()] };
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
   * Replays a creation already committed under the key, finishing its first Run if a crash interrupted
   * it. A replaying request never compensates: the Project belongs to the request that committed it.
   */
  async function replay(body: ProjectCreateBody, fingerprint: string): Promise<ProjectCreation | null> {
    const found = await store.findCreation(body.idempotencyKey);
    if (!found) return null;
    if (found.deleted) throw new RuntimeEntityNotFoundError("project", found.project.projectId);
    if (found.fingerprint !== fingerprint) throw new ProjectIdempotencyConflictError();
    return found.run ? { project: found.project, run: found.run } : admitFirstRun(found.project, body);
  }

  async function createOnce(body: ProjectCreateBody, fingerprint: string): Promise<ProjectCreation> {
    const projectId = crypto.randomUUID();
    const { datasets, samples } = await snapshotSources(body, projectId);
    const outputSchema = body.evaluation && await schemaRef(body.evaluation.outputSchemaId);
    const project: Project = {
      projectId, ownerUserId, name: body.name,
      ...(body.description === undefined ? {} : { description: body.description }),
      sourceBranch: input.sourceBranch, createdAt: new Date().toISOString(),
    };
    const copies: string[] = [];
    try {
      const subject = await agentConfigs.freeze(body.execution.userAgentId);
      copies.push(subject.userAgentId);
      const evaluator = body.evaluation && await agentConfigs.freeze(body.evaluation.userAgentId);
      if (evaluator) copies.push(evaluator.userAgentId);
      const execution = normalizeExecutionPlan({
        ...agentPolicy(ownerUserId, body.execution.framework, subject.userAgentId, body.execution),
        subjectAgentConfig: subject.snapshot,
        executionConcurrency: body.execution.executionConcurrency,
      });
      const evaluation = body.evaluation && evaluator && outputSchema
        ? evaluationPlan(body.evaluation, evaluator, outputSchema) : null;
      await store.create({
        project,
        datasets,
        samples,
        execution: { plan: execution, digest: await digestExecutionPlan({ execution, datasets, samples }) },
        evaluation: evaluation && { plan: evaluation, digest: await digestEvaluationPlan(evaluation) },
        agentConfigs: [
          { userAgentId: subject.userAgentId, role: "subject", snapshot: subject.snapshot },
          ...(evaluator ? [{ userAgentId: evaluator.userAgentId, role: "evaluator" as const, snapshot: evaluator.snapshot }] : []),
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
      // Only the request that committed this Project compensates it, and only while it has no Run.
      const removed = await store.deleteUnrun(projectId).catch(() => null);
      if (removed) await agentConfigs.discard(removed);
      throw error;
    }
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
        throw new ProjectInputError("A pipeline Run requires an evaluation plan", "evaluation");
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
          plan, digest: await digestEvaluationPlan(plan),
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
