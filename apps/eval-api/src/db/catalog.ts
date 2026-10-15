import type { AgentRole, EvaluationOutputSchema, Project } from "@eval-platform/eval-contracts";
import { DatasetEntityNotFoundError, dataSchema } from "@eval-platform/eval-dataset";
import type { RuntimeCatalog, Sample } from "@eval-platform/eval-runtime";
import { RuntimeAdmissionConflictError, RuntimeEntityNotFoundError } from "@eval-platform/eval-runtime";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { EVALUATION_SAMPLING_IDS } from "../limits.js";
import { isPageSize, MAX_PAGE_SIZE, selectByIds } from "./batch.js";
import { platformId, requiredCatalogLabel } from "./catalog-metadata.js";
import type { EvalDb } from "./client.js";
import { createPostgresDatasetStore } from "./dataset.js";
import { CatalogInputError, EvaluationSelectionTooLargeError, OutputSchemaNotFoundError } from "./errors.js";
import { requireOwnerUserId } from "./owner.js";
import { requireEvalSpRelease, type EvalSpRelease } from "./release.js";
import { samplingSucceeded, type RecordReader } from "./run-records.js";
import { data, evaluationOutputSchemas, projects, samples, samplings } from "./schema.js";

export interface SuccessfulSamplingOption {
  readonly samplingId: string;
  readonly sampleId: string;
}

export interface SuccessfulSamplingPage {
  readonly samplings: readonly SuccessfulSamplingOption[];
  readonly nextCursor: string | null;
}

export interface SuccessfulSamplingFilter {
  readonly sampleId?: string;
}

export interface SuccessfulSamplingPageRequest extends SuccessfulSamplingFilter {
  readonly afterSamplingId?: string;
  readonly limit?: number;
}

export interface PostgresCatalog extends RuntimeCatalog {
  createProject(input: Pick<Project, "name">): Promise<Project>;
  bindEvaluationOutputSchema(projectId: string, outputSchemaId: string | null): Promise<Project>;
  createSample(dataId: string): Promise<Sample>;
  listSuccessfulSamplings(projectId: string, input?: SuccessfulSamplingPageRequest): Promise<SuccessfulSamplingPage>;
  selectAllSuccessfulSamplingIds(projectId: string, filter?: SuccessfulSamplingFilter): Promise<readonly string[]>;
}

export type PostgresProjectCatalog = Omit<PostgresCatalog, "listAgents">;

export type ProjectWithOutputSchema = Project & { readonly evaluationOutputSchema?: EvaluationOutputSchema };

function successfulSamplingCondition(projectId: string, ownerUserId: string, sampleId?: string) {
  return and(
    eq(samplings.ownerUserId, ownerUserId),
    eq(samplings.projectId, projectId),
    samplingSucceeded(),
    sampleId === undefined ? undefined : eq(samplings.sampleId, sampleId),
  );
}

function toSample(row: { sampleId: string; dataId: string; content: typeof data.$inferSelect.content }): Sample {
  return { sampleId: row.sampleId, data: dataSchema.parse({ ...row.content, dataId: row.dataId }) };
}

export function projectFromRow(row: typeof projects.$inferSelect): Project {
  return {
    projectId: row.projectId,
    ownerUserId: row.ownerUserId,
    name: row.name,
    sourceBranch: row.sourceBranch,
    ...(row.evaluationOutputSchemaId === null ? {} : { evaluationOutputSchemaId: row.evaluationOutputSchemaId }),
    ...(row.initialLaunch === null ? {} : { initialLaunch: row.initialLaunch }),
  };
}

/** Project persists only the output-format ID; this resolves its immutable file content. Omit the owner only for the Worker. */
export async function readProject(
  reader: RecordReader, projectId: string, ownerUserId?: string,
): Promise<ProjectWithOutputSchema | null> {
  const [row] = await reader.select({ project: projects, schema: evaluationOutputSchemas.schema }).from(projects)
    .leftJoin(evaluationOutputSchemas, and(
      eq(evaluationOutputSchemas.ownerUserId, projects.ownerUserId),
      eq(evaluationOutputSchemas.outputSchemaId, projects.evaluationOutputSchemaId),
    ))
    .where(and(eq(projects.projectId, projectId),
      ownerUserId === undefined ? undefined : eq(projects.ownerUserId, ownerUserId)));
  if (!row) return null;
  const project = projectFromRow(row.project);
  return row.schema === null ? project : { ...project, evaluationOutputSchema: row.schema };
}

/** One Sample or null per requested ID, in request order. Omit the owner only for the Worker. */
export async function readSamples(
  reader: RecordReader, sampleIds: readonly string[], ownerUserId?: string,
): Promise<(Sample | null)[]> {
  const rows = await selectByIds(sampleIds, (batch) => reader
    .select({ sampleId: samples.sampleId, dataId: data.dataId, content: data.content })
    .from(samples).innerJoin(data, eq(samples.dataId, data.dataId))
    .where(and(inArray(samples.sampleId, batch),
      ownerUserId === undefined ? undefined : eq(samples.ownerUserId, ownerUserId))), (row) => row.sampleId);
  return rows.map((row) => row && toSample(row));
}

export async function bindProjectEvaluationOutputSchema(
  db: EvalDb,
  ownerUserId: string,
  projectId: string,
  outputSchemaId: string | null,
): Promise<Project> {
  const owner = requireOwnerUserId(ownerUserId);
  const selectedId = outputSchemaId === null ? null : platformId(outputSchemaId, "outputSchemaId");
  return db.transaction(async (transaction) => {
    const [row] = await transaction.select().from(projects)
      .where(and(eq(projects.ownerUserId, owner), eq(projects.projectId, projectId))).for("update");
    if (!row) throw new RuntimeEntityNotFoundError("project", projectId);
    if (row.evaluationOutputSchemaId === selectedId) return projectFromRow(row);
    if (row.evaluationOutputSchemaLocked) {
      throw new RuntimeAdmissionConflictError("output-schema",
        "Project evaluation output JSON Schema cannot change after evaluation admission");
    }
    if (selectedId !== null) {
      const [selected] = await transaction.select({ outputSchemaId: evaluationOutputSchemas.outputSchemaId })
        .from(evaluationOutputSchemas).where(and(
          eq(evaluationOutputSchemas.ownerUserId, owner),
          eq(evaluationOutputSchemas.outputSchemaId, selectedId),
          isNull(evaluationOutputSchemas.deletedAt),
        )).for("share");
      if (!selected) throw new OutputSchemaNotFoundError(selectedId);
    }
    await transaction.update(projects).set({ evaluationOutputSchemaId: selectedId })
      .where(and(eq(projects.ownerUserId, owner), eq(projects.projectId, projectId)));
    return projectFromRow({ ...row, evaluationOutputSchemaId: selectedId });
  });
}

export function createPostgresProjectCatalog(
  db: EvalDb,
  ownerUserId: string,
  release: EvalSpRelease,
): PostgresProjectCatalog {
  const owner = requireOwnerUserId(ownerUserId);
  const { sourceBranch } = requireEvalSpRelease(release);
  const datasetStore = createPostgresDatasetStore(db, owner);
  return {
    async createProject(input) {
      const name = requiredCatalogLabel(input.name, "name");
      const project: Project = { projectId: crypto.randomUUID(), ownerUserId: owner, name, sourceBranch };
      await db.insert(projects).values(project);
      return project;
    },
    getProject(projectId) {
      return readProject(db, projectId, owner);
    },
    async bindEvaluationOutputSchema(projectId, outputSchemaId) {
      return bindProjectEvaluationOutputSchema(db, owner, projectId, outputSchemaId);
    },
    async listProjects() {
      const rows = await db.select().from(projects)
        .where(eq(projects.ownerUserId, owner))
        .orderBy(projects.projectId);
      return rows.map(projectFromRow);
    },
    listDatasets() {
      return datasetStore.listDatasets();
    },
    listData(datasetId) {
      return datasetStore.listData(datasetId);
    },
    async createSample(dataId) {
      return db.transaction(async (transaction) => {
        const [record] = await transaction.select().from(data)
          .where(and(eq(data.ownerUserId, owner), eq(data.dataId, dataId), isNull(data.deletedAt)))
          .for("share");
        if (!record) throw new DatasetEntityNotFoundError("data", dataId);
        const sampleId = crypto.randomUUID();
        await transaction.insert(samples).values({ sampleId, ownerUserId: owner, dataId });
        return toSample({ sampleId, dataId: record.dataId, content: record.content });
      });
    },
    async listSamples(dataId) {
      const records = await db.select({ sampleId: samples.sampleId, dataId: data.dataId, content: data.content })
        .from(samples).innerJoin(data, eq(samples.dataId, data.dataId))
        .where(and(eq(samples.ownerUserId, owner), eq(samples.dataId, dataId))).orderBy(samples.sampleId);
      return records.map(toSample);
    },
    async getSample(sampleId) {
      return (await readSamples(db, [sampleId], owner))[0] ?? null;
    },
    getSamples(sampleIds) {
      return readSamples(db, sampleIds, owner);
    },
    async listSuccessfulSamplings(projectId, input = {}) {
      const limit = input.limit ?? 100;
      if (!isPageSize(limit)) {
        throw new CatalogInputError(`Successful Sampling page size must be between 1 and ${MAX_PAGE_SIZE}`, "limit");
      }
      const rows = await db.select({
        samplingId: samplings.samplingId,
        sampleId: samplings.sampleId,
      }).from(samplings)
        .where(and(
          successfulSamplingCondition(projectId, owner, input.sampleId),
          input.afterSamplingId === undefined ? undefined : gt(samplings.samplingId, input.afterSamplingId),
        ))
        .orderBy(samplings.samplingId).limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { samplings: page, nextCursor: rows.length > limit && last ? last.samplingId : null };
    },
    async selectAllSuccessfulSamplingIds(projectId, filter = {}) {
      const rows = await db.select({ samplingId: samplings.samplingId })
        .from(samplings)
        .where(successfulSamplingCondition(projectId, owner, filter.sampleId))
        .orderBy(samplings.samplingId).limit(EVALUATION_SAMPLING_IDS + 1);
      if (rows.length > EVALUATION_SAMPLING_IDS) throw new EvaluationSelectionTooLargeError();
      return rows.map(({ samplingId }) => samplingId);
    },
  };
}

export function createPostgresCatalog(
  db: EvalDb,
  ownerUserId: string,
  agents: { readonly listAgents: (role?: AgentRole) => ReturnType<RuntimeCatalog["listAgents"]> },
  release: EvalSpRelease,
): PostgresCatalog {
  return {
    ...createPostgresProjectCatalog(db, ownerUserId, release),
    listAgents(role) { return agents.listAgents(role); },
  };
}
