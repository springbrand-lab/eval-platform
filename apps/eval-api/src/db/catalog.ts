import type { AgentRole, Project } from "@eval-platform/eval-contracts";
import { DatasetEntityNotFoundError, dataSchema } from "@eval-platform/eval-dataset";
import type { RuntimeCatalog, Sample } from "@eval-platform/eval-runtime";
import { eq, inArray } from "drizzle-orm";
import { isForeignKeyFailure, type EvalDb } from "./client.js";
import { createPostgresDatasetStore } from "./dataset.js";
import { data, projects, samples } from "./schema.js";

export interface PostgresCatalog extends RuntimeCatalog {
  createProject(input: Pick<Project, "ownerUserId" | "name">): Promise<Project>;
  getProject(projectId: string): Promise<Project | null>;
  listProjectsByOwner(ownerUserId: string): Promise<readonly Project[]>;
  createSample(dataId: string): Promise<Sample>;
}

function identifier(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty identifier without surrounding whitespace`);
  }
  return value;
}

function toSample(row: { sampleId: string; dataId: string; content: typeof data.$inferSelect.content }): Sample {
  return { sampleId: row.sampleId, data: dataSchema.parse({ ...row.content, dataId: row.dataId }) };
}

export async function readSamples(reader: Pick<EvalDb, "select">, sampleIds: readonly string[]): Promise<readonly Sample[]> {
  if (sampleIds.length === 0) return [];
  const records = await reader.select({ sampleId: samples.sampleId, dataId: data.dataId, content: data.content })
    .from(samples).innerJoin(data, eq(samples.dataId, data.dataId))
    .where(inArray(samples.sampleId, sampleIds)).orderBy(samples.sampleId);
  return records.map(toSample);
}

export function createPostgresCatalog(
  db: EvalDb,
  agents: { readonly listAgents: (role?: AgentRole) => ReturnType<RuntimeCatalog["listAgents"]> },
): PostgresCatalog {
  const datasetStore = createPostgresDatasetStore(db);
  return {
    async createProject(input) {
      const ownerUserId = identifier(input.ownerUserId, "ownerUserId");
      const name = input.name.trim();
      if (name.length === 0) throw new TypeError("Project name must not be blank");
      const project: Project = { projectId: crypto.randomUUID(), ownerUserId, name };
      await db.insert(projects).values(project);
      return project;
    },
    async getProject(projectId) {
      const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId));
      return row ?? null;
    },
    async listProjects() {
      return db.select().from(projects).orderBy(projects.projectId);
    },
    async listProjectsByOwner(ownerUserId) {
      return db.select().from(projects)
        .where(eq(projects.ownerUserId, identifier(ownerUserId, "ownerUserId")))
        .orderBy(projects.projectId);
    },
    listAgents(role) {
      return agents.listAgents(role);
    },
    listDatasets() {
      return datasetStore.listDatasets();
    },
    listData(datasetId) {
      return datasetStore.listData(datasetId);
    },
    async createSample(dataId) {
      const [record] = await db.select().from(data).where(eq(data.dataId, dataId));
      if (!record) throw new DatasetEntityNotFoundError("data", dataId);
      const sampleId = crypto.randomUUID();
      try {
        await db.insert(samples).values({ sampleId, dataId });
      } catch (error) {
        if (isForeignKeyFailure(error)) {
          throw new DatasetEntityNotFoundError("data", dataId);
        }
        throw error;
      }
      return toSample({ sampleId, dataId: record.dataId, content: record.content });
    },
    async listSamples(dataId) {
      const records = await db.select({ sampleId: samples.sampleId, dataId: data.dataId, content: data.content })
        .from(samples).innerJoin(data, eq(samples.dataId, data.dataId))
        .where(eq(samples.dataId, dataId)).orderBy(samples.sampleId);
      return records.map(toSample);
    },
    async getSample(sampleId) {
      return (await readSamples(db, [sampleId]))[0] ?? null;
    },
  };
}
