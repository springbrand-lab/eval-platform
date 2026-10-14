import type { AgentRole, Project } from "@eval-platform/eval-contracts";
import { DatasetEntityNotFoundError, dataSchema } from "@eval-platform/eval-dataset";
import type { RuntimeCatalog, Sample } from "@eval-platform/eval-runtime";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { isForeignKeyFailure, type EvalDb } from "./client.js";
import { createPostgresDatasetStore } from "./dataset.js";
import { requireOwnerUserId } from "./owner.js";
import { sqlBatches } from "./batch.js";
import { requireEvalSpRelease, type EvalSpRelease } from "./release.js";
import { data, evaluationOutputSchemas, projects, samples, samplings } from "./schema.js";
import { EvaluationSelectionTooLargeError, MAX_EVALUATION_SAMPLING_IDS } from "../independent-evaluation-limits.js";
import { catalogId, OutputSchemaNotFoundError } from "./output-schemas.js";

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
  bindEvaluationOutputSchema(projectId: string, outputSchemaId: string): Promise<Project>;
  createSample(dataId: string): Promise<Sample>;
  listSuccessfulSamplings(projectId: string, input?: SuccessfulSamplingPageRequest): Promise<SuccessfulSamplingPage>;
  selectAllSuccessfulSamplingIds(projectId: string, filter?: SuccessfulSamplingFilter): Promise<readonly string[]>;
}

export type PostgresProjectCatalog = Omit<PostgresCatalog, "listAgents">;

function successfulSamplingCondition(projectId: string, ownerUserId: string, sampleId?: string) {
  return and(
    eq(projects.projectId, projectId),
    eq(projects.ownerUserId, ownerUserId),
    sql`${samplings.facts}->'execution'->>'status' = 'succeeded'`,
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

/** Worker projection: Project persists only the ID; this resolves immutable file content. */
export async function projectWithOutputSchema(
  reader: Pick<EvalDb, "select">, row: typeof projects.$inferSelect,
): Promise<Project & { readonly evaluationOutputSchema?: typeof evaluationOutputSchemas.$inferSelect.schema }> {
  const project = projectFromRow(row);
  if (row.evaluationOutputSchemaId === null) return project;
  const [selected] = await reader.select({ schema: evaluationOutputSchemas.schema })
    .from(evaluationOutputSchemas).where(and(
      eq(evaluationOutputSchemas.ownerUserId, row.ownerUserId),
      eq(evaluationOutputSchemas.outputSchemaId, row.evaluationOutputSchemaId),
    ));
  if (!selected) throw new OutputSchemaNotFoundError(row.evaluationOutputSchemaId);
  return { ...project, evaluationOutputSchema: selected.schema };
}

export async function readSamples(
  reader: Pick<EvalDb, "select">,
  ownerUserId: string,
  sampleIds: readonly string[],
): Promise<readonly Sample[]> {
  if (sampleIds.length === 0) return [];
  const records = await reader.select({ sampleId: samples.sampleId, dataId: data.dataId, content: data.content })
    .from(samples).innerJoin(data, eq(samples.dataId, data.dataId))
    .where(and(eq(samples.ownerUserId, ownerUserId), inArray(samples.sampleId, sampleIds)))
    .orderBy(samples.sampleId);
  return records.map(toSample);
}

export async function bindProjectEvaluationOutputSchema(
  db: EvalDb,
  ownerUserId: string,
  projectId: string,
  outputSchemaId: string,
): Promise<Project> {
  const owner = requireOwnerUserId(ownerUserId);
  const selectedId = catalogId(outputSchemaId);
  return db.transaction(async (transaction) => {
    const [row] = await transaction.select().from(projects)
      .where(and(eq(projects.ownerUserId, owner), eq(projects.projectId, projectId))).for("update");
    if (!row) throw new Error(`Unknown Project ${projectId}`);
    if (row.evaluationOutputSchemaId === selectedId) return projectFromRow(row);
    if (row.evaluationOutputSchemaLocked) {
      throw new Error("Project evaluation output JSON Schema cannot change after evaluation admission");
    }
    const [selected] = await transaction.select({ outputSchemaId: evaluationOutputSchemas.outputSchemaId })
      .from(evaluationOutputSchemas).where(and(
        eq(evaluationOutputSchemas.ownerUserId, owner),
        eq(evaluationOutputSchemas.outputSchemaId, selectedId),
        isNull(evaluationOutputSchemas.deletedAt),
      )).for("share");
    if (!selected) throw new OutputSchemaNotFoundError(selectedId);
    const [updated] = await transaction.update(projects).set({ evaluationOutputSchemaId: selectedId })
      .where(and(eq(projects.ownerUserId, owner), eq(projects.projectId, projectId))).returning();
    return projectFromRow(updated!);
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
      const name = input.name.trim();
      if (name.length === 0) throw new TypeError("Project name must not be blank");
      const project: Project = { projectId: crypto.randomUUID(), ownerUserId: owner, name, sourceBranch };
      await db.insert(projects).values(project);
      return project;
    },
    async getProject(projectId) {
      const [row] = await db.select().from(projects)
        .where(and(eq(projects.ownerUserId, owner), eq(projects.projectId, projectId)));
      return row ? projectWithOutputSchema(db, row) : null;
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
        try {
          await transaction.insert(samples).values({ sampleId, ownerUserId: owner, dataId });
        } catch (error) {
          if (isForeignKeyFailure(error)) throw new DatasetEntityNotFoundError("data", dataId);
          throw error;
        }
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
      return (await readSamples(db, owner, [sampleId]))[0] ?? null;
    },
    async getSamples(sampleIds) {
      const byId = new Map<string, Sample>();
      for (const batch of sqlBatches([...new Set(sampleIds)])) {
        for (const sample of await readSamples(db, owner, batch)) byId.set(sample.sampleId, sample);
      }
      return sampleIds.map((sampleId) => byId.get(sampleId) ?? null);
    },
    async listSuccessfulSamplings(projectId, input = {}) {
      const limit = input.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new TypeError("Successful Sampling page size must be between 1 and 1000");
      }
      const rows = await db.select({
        samplingId: samplings.samplingId,
        sampleId: samplings.sampleId,
      }).from(samplings).innerJoin(projects, eq(samplings.projectId, projects.projectId))
        .where(and(
          successfulSamplingCondition(projectId, owner, input.sampleId),
          input.afterSamplingId === undefined ? undefined : gt(samplings.samplingId, input.afterSamplingId),
        ))
        .orderBy(samplings.samplingId).limit(limit + 1);
      const page = rows.slice(0, limit);
      return {
        samplings: page,
        nextCursor: rows.length > limit ? page.at(-1)!.samplingId : null,
      };
    },
    async selectAllSuccessfulSamplingIds(projectId, filter = {}) {
      const rows = await db.select({ samplingId: samplings.samplingId })
        .from(samplings).innerJoin(projects, eq(samplings.projectId, projects.projectId))
        .where(successfulSamplingCondition(projectId, owner, filter.sampleId))
        .orderBy(samplings.samplingId).limit(MAX_EVALUATION_SAMPLING_IDS + 1);
      if (rows.length > MAX_EVALUATION_SAMPLING_IDS) throw new EvaluationSelectionTooLargeError();
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
