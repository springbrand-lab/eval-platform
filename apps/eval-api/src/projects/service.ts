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
  digestExecutionPlan,
  normalizeEvaluationPlan,
  normalizeExecutionPlan,
} from "@eval-platform/eval-runtime";
import type { AgentConfigService, FrozenCopy } from "../agent-configs.js";
import { OutputSchemaNotFoundError, ProjectInputError } from "../db/errors.js";
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
  readonly run: { readonly operation: "execution" | "pipeline"; readonly idempotencyKey: string };
}

function runtimeOf(timeoutMs: number | undefined) {
  return timeoutMs === undefined ? {} : { runtime: { timeoutMs } };
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
    return normalizeEvaluationPlan({
      evaluationHarness: {
        kind: "sp", framework: "sp", agentConfig: { ownerUserId, userAgentId: copy.userAgentId }, ...runtimeOf(body.timeoutMs),
      },
      evaluatorAgentConfig: copy.snapshot,
      evaluationConcurrency: body.evaluationConcurrency,
      ...(body.retryPolicy === undefined ? {} : { retryPolicy: body.retryPolicy }),
      outputSchema,
    });
  }

  /** Builds the Dataset snapshots and one ProjectSample per distinct Data, in binding order. */
  async function snapshotSources(body: ProjectCreateBody) {
    const selected = await store.readSelection(body.datasets);
    const samples = new Map<string, ProjectSample & { datasetIds: string[] }>();
    const datasets: ProjectDatasetSnapshot[] = selected.map(({ dataset, data }) => ({
      ...dataset,
      projectSampleIds: data.map((record) => {
        let sample = samples.get(record.dataId);
        if (!sample) {
          sample = {
            projectSampleId: crypto.randomUUID(), projectId: "", dataId: record.dataId, datasetIds: [],
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

  return {
    list: () => store.list(),
    exists: (projectId: string) => store.exists(projectId),
    get: (projectId: string) => store.get(projectId),
    delete: (projectId: string) => store.softDelete(projectId),

    /** Snapshot, freeze, persist and admit the first Run; nothing remains visible when any step fails. */
    async create(body: ProjectCreateBody): Promise<{ project: Project; run: RunHandle }> {
      if (body.run.operation === "pipeline" && body.evaluation === undefined) {
        throw new ProjectInputError("A pipeline Run requires an evaluation plan", "evaluation");
      }
      const sources = await snapshotSources(body);
      const outputSchema = body.evaluation && await schemaRef(body.evaluation.outputSchemaId);
      const projectId = crypto.randomUUID();
      const project: Project = {
        projectId, ownerUserId, name: body.name,
        ...(body.description === undefined ? {} : { description: body.description }),
        sourceBranch: input.sourceBranch, createdAt: new Date().toISOString(),
      };
      const samples = sources.samples.map((sample) => ({ ...sample, projectId }));
      const copies: string[] = [];
      try {
        const subject = await agentConfigs.freeze(body.execution.userAgentId);
        copies.push(subject.userAgentId);
        const evaluator = body.evaluation && await agentConfigs.freeze(body.evaluation.userAgentId);
        if (evaluator) copies.push(evaluator.userAgentId);
        const execution = normalizeExecutionPlan({
          harness: {
            kind: "sp", framework: body.execution.framework,
            agentConfig: { ownerUserId, userAgentId: subject.userAgentId }, ...runtimeOf(body.execution.timeoutMs),
          },
          subjectAgentConfig: subject.snapshot,
          executionConcurrency: body.execution.executionConcurrency,
          ...(body.execution.retryPolicy === undefined ? {} : { retryPolicy: body.execution.retryPolicy }),
        });
        const evaluation = body.evaluation && evaluator && outputSchema
          ? evaluationPlan(body.evaluation, evaluator, outputSchema) : null;
        await store.create({
          project,
          datasets: sources.datasets,
          samples,
          execution: { plan: execution, digest: await digestExecutionPlan({ execution, datasets: sources.datasets, samples }) },
          evaluation: evaluation && { plan: evaluation, digest: await digestEvaluationPlan(evaluation) },
          agentConfigs: [
            { userAgentId: subject.userAgentId, role: "subject", snapshot: subject.snapshot },
            ...(evaluator ? [{ userAgentId: evaluator.userAgentId, role: "evaluator" as const, snapshot: evaluator.snapshot }] : []),
          ],
        });
      } catch (error) {
        await agentConfigs.discard(copies);
        throw error;
      }
      try {
        const { operation, idempotencyKey } = body.run;
        const { targets } = await admission.preview({ projectId, operation, selector: { all: true } });
        const run = await admission.submit({ idempotencyKey, projectId, operation, selector: { all: true }, targets });
        return { project, run };
      } catch (error) {
        if (await store.deleteUnrun(projectId).catch(() => false)) await agentConfigs.discard(copies);
        throw error;
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
