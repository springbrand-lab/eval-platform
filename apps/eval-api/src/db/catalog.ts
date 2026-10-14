import type { AgentRole, Project } from "@eval-platform/eval-contracts";
import { DatasetEntityNotFoundError, dataSchema } from "@eval-platform/eval-dataset";
import type { RuntimeCatalog, Sample } from "@eval-platform/eval-runtime";
import { and, eq, inArray } from "drizzle-orm";
import { isForeignKeyFailure, type EvalDb } from "./client.js";
import { createPostgresDatasetStore } from "./dataset.js";
import { requireOwnerUserId } from "./owner.js";
import { data, projects, samples } from "./schema.js";

export interface PostgresCatalog extends RuntimeCatalog {
  createProject(input: Pick<Project, "name">): Promise<Project>;
  getProject(projectId: string): Promise<Project | null>;
  createSample(dataId: string): Promise<Sample>;
}

function toSample(row: { sampleId: string; dataId: string; content: typeof data.$inferSelect.content }): Sample {
  return { sampleId: row.sampleId, data: dataSchema.parse({ ...row.content, dataId: row.dataId }) };
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

export function createPostgresCatalog(
  db: EvalDb,
  ownerUserId: string,
  agents: { readonly listAgents: (role?: AgentRole) => ReturnType<RuntimeCatalog["listAgents"]> },
): PostgresCatalog {
  const owner = requireOwnerUserId(ownerUserId);
  const datasetStore = createPostgresDatasetStore(db, owner);
  return {
    async createProject(input) {
      const name = input.name.trim();
      if (name.length === 0) throw new TypeError("Project name must not be blank");
      const project: Project = { projectId: crypto.randomUUID(), ownerUserId: owner, name };
      await db.insert(projects).values(project);
      return project;
    },
    async getProject(projectId) {
      const [row] = await db.select().from(projects)
        .where(and(eq(projects.ownerUserId, owner), eq(projects.projectId, projectId)));
      return row ?? null;
    },
    async listProjects() {
      return db.select().from(projects)
        .where(eq(projects.ownerUserId, owner))
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
      const [record] = await db.select().from(data)
        .where(and(eq(data.ownerUserId, owner), eq(data.dataId, dataId)));
      if (!record) throw new DatasetEntityNotFoundError("data", dataId);
      const sampleId = crypto.randomUUID();
      try {
        await db.insert(samples).values({ sampleId, ownerUserId: owner, dataId });
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
        .where(and(eq(samples.ownerUserId, owner), eq(samples.dataId, dataId))).orderBy(samples.sampleId);
      return records.map(toSample);
    },
    async getSample(sampleId) {
      return (await readSamples(db, owner, [sampleId]))[0] ?? null;
    },
  };
}
