import { eq } from "drizzle-orm";
import { Pool, type QueryConfig } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDashboardService } from "../dashboards/service.js";
import { constraintViolation, createEvalDb } from "./client.js";
import { createPostgresDashboardStore } from "./dashboards.js";
import { createPostgresProjectPlanReader } from "./project-plans.js";
import { createPostgresRuntimeStore } from "./runtime.js";
import { dashboardProjects, dashboards, projects } from "./schema.js";
import { createTestDatabase } from "./test-database.js";
import { buildCommand, makeData, release, seedProject } from "./test-fixtures.js";

const connection = process.env.DATABASE_URL;
const owner = "dashboard-persistence-test";

describe.skipIf(!connection)("PostgreSQL saved Dashboards", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => { database = await createTestDatabase(connection!); }, 30_000);
  afterAll(async () => { if (database) await database.destroy(); }, 30_000);

  async function fixture() {
    const ids: string[] = [];
    const plans = createPostgresProjectPlanReader(database.db, owner);
    const runtime = createPostgresRuntimeStore(database.db, owner, release, { async enqueue() {} });
    for (let index = 0; index < 3; index++) {
      const { projectId } = await seedProject(database.db, owner, { datasets: [{ data: [makeData()] }] });
      await runtime.admitRun(await buildCommand(plans, runtime, { projectId, operation: "execution" }));
      ids.push(projectId);
    }
    const store = createPostgresDashboardStore(database.db, owner);
    const service = createDashboardService(store);
    const input = { name: " Board ", projectIds: [ids[1]!, ids[0]!], idempotencyKey: crypto.randomUUID() };
    return { ids, store, service, input };
  }

  it("coordinates concurrent creations, keeps the original fingerprint after edits, and rejects stale concurrent revisions", async () => {
    const f = await fixture();
    const [created, replay] = await Promise.all([f.service.create(f.input), f.service.create({ ...f.input, description: "" })]);
    expect(replay).toEqual(created);
    const [original] = await database.db.select().from(dashboards).where(eq(dashboards.dashboardId, created.dashboardId));
    const edits = await Promise.allSettled(["A", "B"].map((name) => f.service.update(created.dashboardId, {
      name, projectIds: [f.ids[2]!, f.ids[0]!], revision: 1,
    })));
    expect(edits.filter((edit) => edit.status === "fulfilled")).toHaveLength(1);
    expect(edits.find((edit) => edit.status === "rejected")).toMatchObject({ reason: { name: "DashboardRevisionConflictError" } });
    const updated = await f.service.get(created.dashboardId);
    expect(updated.revision).toBe(2);
    expect(updated.projectIds).toEqual([f.ids[2], f.ids[0]]);
    await database.db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.projectId, f.ids[1]!));
    expect(await f.service.create({ ...f.input, name: "Board" })).toEqual(updated);
    await expect(f.service.create({ ...f.input, name: "Different" })).rejects.toMatchObject({ name: "DashboardIdempotencyConflictError" });
    const [after] = await database.db.select().from(dashboards).where(eq(dashboards.dashboardId, created.dashboardId));
    expect(after?.creationFingerprint).toBe(original?.creationFingerprint);
    expect((await f.service.list()).filter((dashboard) => dashboard.dashboardId === created.dashboardId)).toEqual([updated]);
  });

  it("rolls back invalid Project selections and isolates unknown or foreign Dashboards without losing saved references", async () => {
    const f = await fixture();
    const foreign = await seedProject(database.db, "other-owner", { datasets: [{ data: [makeData()] }] });
    await database.db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.projectId, f.ids[2]!));
    const before = await f.service.list();
    for (const projectId of ["unknown", foreign.projectId, f.ids[2]!]) {
      await expect(f.service.create({ ...f.input, projectIds: [f.ids[0]!, projectId] }))
        .rejects.toMatchObject({ name: "DashboardProjectNotFoundError", projectId });
      expect(await f.service.list()).toEqual(before);
    }
    const created = await f.service.create(f.input);
    for (const projectId of ["unknown", foreign.projectId, f.ids[2]!]) {
      await expect(f.service.update(created.dashboardId, { name: "Partial", projectIds: [projectId, f.ids[0]!], revision: 1 }))
        .rejects.toMatchObject({ name: "DashboardProjectNotFoundError", projectId });
      expect(await f.service.get(created.dashboardId)).toEqual(created);
    }
    const other = createDashboardService(createPostgresDashboardStore(database.db, "other-owner"));
    for (const dashboardId of [created.dashboardId, crypto.randomUUID()]) {
      await expect(other.get(dashboardId)).rejects.toMatchObject({ name: "DashboardNotFoundError", dashboardId });
      await expect(other.update(dashboardId, { name: "Foreign", projectIds: f.input.projectIds, revision: 1 }))
        .rejects.toMatchObject({ name: "DashboardNotFoundError", dashboardId });
    }
    await database.db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.projectId, f.ids[1]!));
    expect(await f.service.get(created.dashboardId)).toEqual(created);
  });

  it("pins metadata and ordered associations to the same repeatable-read snapshot during an edit", async () => {
    const f = await fixture();
    const created = await f.service.create(f.input);
    const pool = new Pool({ connectionString: database.connectionString, max: 1 });
    const connect = pool.connect.bind(pool);
    let changed = false;
    const statements: string[] = [];
    Object.assign(pool, {
      connect: async () => {
        const client = await connect();
        const query = client.query.bind(client);
        return Object.assign(client, {
          query: async (config: QueryConfig, params: unknown[] = []) => {
            const result = await query(config, params);
            statements.push(config.text);
            if (!changed && config.text.includes(' from "eval_dashboards"') && params.includes(created.dashboardId)) {
              changed = true;
              await f.service.update(created.dashboardId, { name: "Changed", projectIds: [f.ids[2]!, f.ids[0]!], revision: 1 });
            }
            return result;
          },
        });
      },
    });
    try {
      expect(await createPostgresDashboardStore(createEvalDb(pool), owner).get(created.dashboardId)).toEqual(created);
      expect(changed).toBe(true);
      expect(statements[0]).toBe("begin isolation level repeatable read read only");
      expect(statements.at(-1)).toBe("commit");
    } finally {
      await pool.end();
    }
    expect(await f.service.get(created.dashboardId)).toMatchObject({ name: "Changed", projectIds: [f.ids[2], f.ids[0]], revision: 2 });
  });

  it("enforces owner-matched composite foreign keys and unique Project positions in SQL", async () => {
    const f = await fixture();
    const created = await f.service.create(f.input);
    const foreign = await seedProject(database.db, "other-owner", { datasets: [{ data: [makeData()] }] });
    const invalid = [
      [{ ownerUserId: "other-owner", dashboardId: created.dashboardId, projectId: foreign.projectId, position: 2 }, "foreign-key", "eval_dashboard_projects_dashboard_fk"],
      [{ ownerUserId: owner, dashboardId: created.dashboardId, projectId: foreign.projectId, position: 2 }, "foreign-key", "eval_dashboard_projects_project_fk"],
      [{ ownerUserId: owner, dashboardId: created.dashboardId, projectId: f.ids[2]!, position: 1 }, "unique", "eval_dashboard_projects_position_uq"],
    ] as const;
    for (const [row, kind, constraint] of invalid) {
      try {
        await database.db.insert(dashboardProjects).values(row);
        expect.fail("Invalid association was accepted");
      } catch (error) {
        expect(constraintViolation(error)).toEqual({ kind, constraint });
      }
    }
    expect(await f.service.get(created.dashboardId)).toEqual(created);
  });
});
