import { createId, dashboardSchema, type Dashboard, type DashboardInput } from "@eval-platform/eval-contracts";
import { and, asc, desc, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import {
  DashboardIdempotencyConflictError,
  DashboardNotFoundError,
  DashboardProjectNotFoundError,
  DashboardRevisionConflictError,
} from "../dashboards/errors.js";
import type { DashboardStore } from "../dashboards/store.js";
import { addToGroup, selectByIds, sqlBatches } from "./batch.js";
import { READ_SNAPSHOT, type EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import type { RecordReader } from "./run-records.js";
import { dashboardProjects, dashboards, projects, runs } from "./schema.js";

const WRITE_TRANSACTION = { isolationLevel: "read committed", accessMode: "read write" } as const;

async function readDashboards(
  reader: RecordReader, owner: string, rows: readonly (typeof dashboards.$inferSelect)[],
): Promise<Dashboard[]> {
  const members = new Map<string, string[]>();
  for (const batch of sqlBatches(rows.map((row) => row.dashboardId))) {
    const links = await reader.select({ dashboardId: dashboardProjects.dashboardId, projectId: dashboardProjects.projectId })
      .from(dashboardProjects)
      .where(and(eq(dashboardProjects.ownerUserId, owner), inArray(dashboardProjects.dashboardId, batch)))
      .orderBy(dashboardProjects.dashboardId, dashboardProjects.position);
    for (const link of links) addToGroup(members, link.dashboardId, link.projectId);
  }
  return rows.map((row) => dashboardSchema.parse({
    dashboardId: row.dashboardId, name: row.name, description: row.description,
    projectIds: members.get(row.dashboardId) ?? [], excludedDataIds: row.excludedDataIds, revision: row.revision,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  }));
}

async function requireProjects(reader: RecordReader, owner: string, projectIds: readonly string[]): Promise<void> {
  const ordered = [...projectIds].sort();
  const found = await selectByIds(ordered, (batch) => reader.select({ projectId: projects.projectId }).from(projects)
    .where(and(eq(projects.ownerUserId, owner), inArray(projects.projectId, batch), isNull(projects.deletedAt),
      exists(reader.select({ runId: runs.runId }).from(runs).where(eq(runs.projectId, projects.projectId)))))
    .orderBy(asc(projects.projectId)).for("share"), (row) => row.projectId);
  const missing = found.findIndex((row) => row === null);
  if (missing !== -1) throw new DashboardProjectNotFoundError(ordered[missing]!);
}

async function writeProjects(
  writer: Pick<EvalDb, "insert">, owner: string, dashboardId: string, projectIds: readonly string[],
): Promise<void> {
  for (const batch of sqlBatches(projectIds.map((projectId, position) => ({ ownerUserId: owner, dashboardId, projectId, position })))) {
    await writer.insert(dashboardProjects).values(batch);
  }
}

export function createPostgresDashboardStore(db: EvalDb, ownerUserId: string): DashboardStore {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    list() {
      return db.transaction(async (transaction) => {
        const rows = await transaction.select().from(dashboards).where(eq(dashboards.ownerUserId, owner))
          .orderBy(desc(dashboards.updatedAt), asc(dashboards.dashboardId));
        return readDashboards(transaction, owner, rows);
      }, READ_SNAPSHOT);
    },
    get(dashboardId) {
      return db.transaction(async (transaction) => {
        const [row] = await transaction.select().from(dashboards)
          .where(and(eq(dashboards.ownerUserId, owner), eq(dashboards.dashboardId, dashboardId)));
        return row ? (await readDashboards(transaction, owner, [row]))[0]! : null;
      }, READ_SNAPSHOT);
    },
    create(input, creation) {
      return db.transaction(async (transaction) => {
        const [created] = await transaction.insert(dashboards).values({
          dashboardId: createId(), ownerUserId: owner, name: input.name, description: input.description,
          excludedDataIds: input.excludedDataIds,
          creationKey: creation.key, creationFingerprint: creation.fingerprint,
        }).onConflictDoNothing({ target: [dashboards.ownerUserId, dashboards.creationKey] }).returning();
        if (created) {
          await requireProjects(transaction, owner, input.projectIds);
          await writeProjects(transaction, owner, created.dashboardId, input.projectIds);
          return (await readDashboards(transaction, owner, [created]))[0]!;
        }
        const [existing] = await transaction.select().from(dashboards)
          .where(and(eq(dashboards.ownerUserId, owner), eq(dashboards.creationKey, creation.key))).for("update");
        if (!existing) throw new Error("Dashboard creation identity disappeared");
        if (existing.creationFingerprint !== creation.fingerprint) throw new DashboardIdempotencyConflictError();
        return (await readDashboards(transaction, owner, [existing]))[0]!;
      }, WRITE_TRANSACTION);
    },
    update(dashboardId: string, input: DashboardInput, revision: number) {
      return db.transaction(async (transaction) => {
        const [current] = await transaction.select().from(dashboards)
          .where(and(eq(dashboards.ownerUserId, owner), eq(dashboards.dashboardId, dashboardId))).for("update");
        if (!current) throw new DashboardNotFoundError(dashboardId);
        if (current.revision !== revision || revision === Number.MAX_SAFE_INTEGER) throw new DashboardRevisionConflictError(dashboardId);
        await requireProjects(transaction, owner, input.projectIds);
        const [updated] = await transaction.update(dashboards).set({
          name: input.name, description: input.description, revision: revision + 1, updatedAt: sql`clock_timestamp()`,
          excludedDataIds: input.excludedDataIds,
        }).where(and(eq(dashboards.ownerUserId, owner), eq(dashboards.dashboardId, dashboardId), eq(dashboards.revision, revision))).returning();
        if (!updated) throw new DashboardRevisionConflictError(dashboardId);
        await transaction.delete(dashboardProjects)
          .where(and(eq(dashboardProjects.ownerUserId, owner), eq(dashboardProjects.dashboardId, dashboardId)));
        await writeProjects(transaction, owner, dashboardId, input.projectIds);
        return (await readDashboards(transaction, owner, [updated]))[0]!;
      }, WRITE_TRANSACTION);
    },
  };
}
