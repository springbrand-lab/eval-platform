import type { EvaluationOutputSchema, Project, ProjectDatasetSnapshot, ProjectPlan } from "@eval-platform/eval-contracts";
import { planProjectSampleIds, type ProjectPlanReader, type ProjectSample } from "@eval-platform/eval-runtime";
import { and, asc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { addToGroup, selectByIds, sqlBatches } from "./batch.js";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import type { RecordReader } from "./run-records.js";
import {
  evaluationOutputSchemas,
  projectDatasets,
  projectEvaluationPlans,
  projectExecutionPlans,
  projects,
  projectSampleDatasets,
  projectSamples,
} from "./schema.js";

export const READ_SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

/** A non-deleted Project; omit the owner only for the Worker. */
export function visibleProject(projectId: string, ownerUserId?: string): SQL | undefined {
  return and(eq(projects.projectId, projectId), isNull(projects.deletedAt),
    ownerUserId === undefined ? undefined : eq(projects.ownerUserId, ownerUserId));
}

export function projectFromRow(row: typeof projects.$inferSelect): Project {
  return {
    projectId: row.projectId,
    ownerUserId: row.ownerUserId,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    sourceBranch: row.sourceBranch,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Reads one consistent Project plan; call inside a repeatable-read snapshot. Omit the owner only for the Worker. */
export async function readProjectPlan(reader: RecordReader, projectId: string, ownerUserId?: string): Promise<ProjectPlan | null> {
  const [project] = await reader.select().from(projects).where(visibleProject(projectId, ownerUserId));
  if (!project) return null;
  // One transaction client runs one query at a time, so these reads stay sequential.
  const datasetRows = await reader.select().from(projectDatasets)
    .where(eq(projectDatasets.projectId, projectId)).orderBy(asc(projectDatasets.position));
  const memberRows = await reader.select({ datasetId: projectSampleDatasets.datasetId, projectSampleId: projectSampleDatasets.projectSampleId })
    .from(projectSampleDatasets).where(eq(projectSampleDatasets.projectId, projectId))
    .orderBy(projectSampleDatasets.datasetId, projectSampleDatasets.position);
  const [execution] = await reader.select().from(projectExecutionPlans).where(eq(projectExecutionPlans.projectId, projectId));
  const [evaluation] = await reader.select().from(projectEvaluationPlans).where(eq(projectEvaluationPlans.projectId, projectId));
  if (!execution) throw new Error(`Project ${projectId} has no execution plan`);
  const members = new Map<string, string[]>();
  for (const row of memberRows) addToGroup(members, row.datasetId, row.projectSampleId);
  const datasets = datasetRows.map((row): ProjectDatasetSnapshot => ({
    datasetId: row.datasetId,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    kind: row.kind,
    projectSampleIds: members.get(row.datasetId) ?? [],
  }));
  return {
    project: projectFromRow(project),
    datasets,
    execution: execution.plan,
    executionPlanDigest: execution.digest,
    evaluation: evaluation?.plan ?? null,
    evaluationPlanDigest: evaluation?.digest ?? null,
    evaluationPlanLockedAt: evaluation?.lockedAt?.toISOString() ?? null,
  };
}

async function attachDatasetIds(
  reader: RecordReader, projectId: string, rows: readonly (typeof projectSamples.$inferSelect)[],
): Promise<ProjectSample[]> {
  const datasetIds = new Map<string, string[]>();
  for (const batch of sqlBatches(rows.map((row) => row.projectSampleId))) {
    const members = await reader.select({ projectSampleId: projectSampleDatasets.projectSampleId, datasetId: projectSampleDatasets.datasetId })
      .from(projectSampleDatasets)
      .innerJoin(projectDatasets, and(eq(projectDatasets.projectId, projectSampleDatasets.projectId),
        eq(projectDatasets.datasetId, projectSampleDatasets.datasetId)))
      .where(and(eq(projectSampleDatasets.projectId, projectId), inArray(projectSampleDatasets.projectSampleId, batch)))
      .orderBy(asc(projectDatasets.position));
    for (const member of members) {
      addToGroup(datasetIds, member.projectSampleId, member.datasetId);
    }
  }
  return rows.map((row) => ({
    projectSampleId: row.projectSampleId,
    projectId: row.projectId,
    dataId: row.dataId,
    datasetIds: datasetIds.get(row.projectSampleId) ?? [],
    samplingCount: row.samplingCount,
    data: row.data,
  }));
}

/** One ProjectSample or null per requested ID, in request order; the caller has checked the Project. */
export async function readProjectSamples(
  reader: RecordReader, projectId: string, projectSampleIds: readonly string[],
): Promise<(ProjectSample | null)[]> {
  const rows = await selectByIds(projectSampleIds, (batch) => reader.select().from(projectSamples)
    .where(and(eq(projectSamples.projectId, projectId), inArray(projectSamples.projectSampleId, batch))),
  (row) => row.projectSampleId);
  const found = await attachDatasetIds(reader, projectId, rows.filter((row) => row !== null));
  const byId = new Map(found.map((sample) => [sample.projectSampleId, sample]));
  return projectSampleIds.map((id) => byId.get(id) ?? null);
}

/** Every ProjectSample of a Project in plan binding order. */
export async function readAllProjectSamples(reader: RecordReader, plan: ProjectPlan): Promise<ProjectSample[]> {
  const rows = await reader.select().from(projectSamples).where(eq(projectSamples.projectId, plan.project.projectId));
  const order = new Map(planProjectSampleIds(plan).map((id, index) => [id, index]));
  const samples = await attachDatasetIds(reader, plan.project.projectId, rows);
  return samples.sort((left, right) => (order.get(left.projectSampleId) ?? 0) - (order.get(right.projectSampleId) ?? 0));
}

/** Schema content resolved through the Project's evaluation plan, ignoring catalog soft deletes. Omit the owner only for the Worker. */
export async function readEvaluationOutputSchema(
  reader: RecordReader, projectId: string, ownerUserId?: string,
): Promise<EvaluationOutputSchema | null> {
  const [row] = await reader.select({ schema: evaluationOutputSchemas.schema }).from(projects)
    .innerJoin(projectEvaluationPlans, eq(projectEvaluationPlans.projectId, projects.projectId))
    .innerJoin(evaluationOutputSchemas, and(
      eq(evaluationOutputSchemas.ownerUserId, projectEvaluationPlans.ownerUserId),
      eq(evaluationOutputSchemas.outputSchemaId, projectEvaluationPlans.outputSchemaId),
    ))
    .where(visibleProject(projectId, ownerUserId));
  return row?.schema ?? null;
}

export async function projectExists(reader: RecordReader, projectId: string, ownerUserId?: string): Promise<boolean> {
  const [row] = await reader.select({ projectId: projects.projectId }).from(projects).where(visibleProject(projectId, ownerUserId));
  return row !== undefined;
}

function createPlanReader(db: EvalDb, ownerUserId?: string): ProjectPlanReader {
  return {
    getProjectPlan(projectId) {
      return db.transaction((transaction) => readProjectPlan(transaction, projectId, ownerUserId), READ_SNAPSHOT);
    },
    getProjectSamples(projectId, projectSampleIds) {
      return db.transaction(async (transaction) => (await projectExists(transaction, projectId, ownerUserId)
        ? readProjectSamples(transaction, projectId, projectSampleIds)
        : projectSampleIds.map(() => null)), READ_SNAPSHOT);
    },
    getEvaluationOutputSchema(projectId) {
      return readEvaluationOutputSchema(db, projectId, ownerUserId);
    },
  };
}

/** Owner-scoped plan reads for API admission; soft-deleted Projects read as missing. */
export function createPostgresProjectPlanReader(db: EvalDb, ownerUserId: string): ProjectPlanReader {
  return createPlanReader(db, requireOwnerUserId(ownerUserId));
}

/** All-owner plan reads; only the Worker may use it. */
export function createPostgresWorkerProjectPlanReader(db: EvalDb): ProjectPlanReader {
  return createPlanReader(db);
}
