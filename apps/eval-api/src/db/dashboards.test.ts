import { describe, expect, it } from "vitest";
import { createDashboardService } from "../dashboards/service.js";
import { sqlBatches } from "./batch.js";
import { createPostgresDashboardStore } from "./dashboards.js";
import { dashboardOwner, dashboardsDriver } from "./dashboards.test-support.js";
import { createPostgresProjectStore } from "./project-store.js";

const input = { name: " Board ", projectIds: ["second", "first"], idempotencyKey: "create" };

function fixture() {
  const driver = dashboardsDriver();
  return Object.assign(driver, { service: createDashboardService(createPostgresDashboardStore(driver.db, dashboardOwner)) });
}

describe("PostgreSQL Dashboard Store through its public service", () => {
  it("saves Data selection across edits and reopens, restores all, and never overwrites a newer configuration", async () => {
    const f = fixture();
    const saved = await f.service.create(input);
    expect(saved.excludedDataIds).toEqual([]);
    const selected = await f.service.update(saved.dashboardId, {
      name: input.name, projectIds: input.projectIds, excludedDataIds: ["data-b", "data-a"], revision: saved.revision,
    });
    expect(selected.excludedDataIds).toEqual(["data-a", "data-b"]);
    expect((await f.service.get(saved.dashboardId)).excludedDataIds).toEqual(["data-a", "data-b"]);
    const renamed = await f.service.update(saved.dashboardId, { name: "Edited", projectIds: input.projectIds, revision: selected.revision });
    expect(renamed.excludedDataIds).toEqual(["data-a", "data-b"]);
    await expect(f.service.update(saved.dashboardId, { name: "Stale", projectIds: input.projectIds, excludedDataIds: [], revision: selected.revision }))
      .rejects.toMatchObject({ name: "DashboardRevisionConflictError" });
    const restored = await f.service.update(saved.dashboardId, { name: renamed.name, projectIds: input.projectIds, excludedDataIds: [], revision: renamed.revision });
    expect(restored.excludedDataIds).toEqual([]);
    expect((await f.service.list())[0]).toEqual(restored);
  });

  it("creates, lists and reopens normalized configuration with ordered Project associations", async () => {
    const f = fixture();
    const created = await f.service.create(input);
    expect(created).toMatchObject({ name: "Board", description: "", projectIds: ["second", "first"], revision: 1 });
    expect(await f.service.list()).toEqual([created]);
    expect(await f.service.get(created.dashboardId)).toEqual(created);
    expect(f.snapshot().dashboards.size).toBe(1);
    expect(f.snapshot().projects).toMatchObject([
      { dashboardId: created.dashboardId, projectId: "second", position: 0 },
      { dashboardId: created.dashboardId, projectId: "first", position: 1 },
    ]);
    const checks = f.queries.filter((query) => query.text.includes(' from "eval_projects" '));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.text).toMatch(/order by "eval_projects"\."project_id" asc for share$/u);
    expect(checks[0]?.params).toEqual([dashboardOwner, "first", "second"]);
    expect(f.queries.filter((query) => query.text.startsWith("begin")).map((query) => query.text)).toEqual([
      "begin isolation level read committed read write", "begin isolation level repeatable read read only", "begin isolation level repeatable read read only",
    ]);
  });

  it("replays the first normalized creation after editing and never binds its key to a new configuration", async () => {
    const f = fixture();
    const created = await f.service.create(input);
    const updated = await f.service.update(created.dashboardId, { name: "Edited", projectIds: ["third", "first"], revision: 1 });
    expect(updated).toMatchObject({ dashboardId: created.dashboardId, name: "Edited", revision: 2, projectIds: ["third", "first"] });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
    f.projects.get("second")!.deletedAt = new Date();
    expect(await f.service.create({ ...input, name: "Board", description: "" })).toEqual(updated);
    await expect(f.service.create({ ...input, name: "Edited", projectIds: ["third", "first"] }))
      .rejects.toMatchObject({ name: "DashboardIdempotencyConflictError" });
    expect(await f.service.list()).toEqual([updated]);
  });

  it("converges concurrent same-key requests and rejects concurrent different commands", async () => {
    const f = fixture();
    const [first, replay] = await Promise.all([f.service.create(input), f.service.create({ ...input, description: " " })]);
    expect(replay).toEqual(first);
    const results = await Promise.allSettled([
      f.service.create({ ...input, idempotencyKey: "racing", name: "A" }),
      f.service.create({ ...input, idempotencyKey: "racing", name: "B" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { name: "DashboardIdempotencyConflictError" },
    });
    expect(await f.service.list()).toHaveLength(2);
  });

  it.each(["unknown", "foreign", "deleted", "unadmitted"])("rolls back the whole create and update for Project %s", async (projectId) => {
    const f = fixture();
    await expect(f.service.create({ ...input, projectIds: ["first", projectId] }))
      .rejects.toMatchObject({ name: "DashboardProjectNotFoundError", projectId });
    expect(await f.service.list()).toEqual([]);
    const created = await f.service.create(input);
    await expect(f.service.update(created.dashboardId, { name: "Invalid edit", projectIds: [projectId, "first"], revision: 1 }))
      .rejects.toMatchObject({ name: "DashboardProjectNotFoundError", projectId });
    expect(await f.service.get(created.dashboardId)).toEqual(created);
    expect(f.queries.filter((query) => query.text === "rollback")).toHaveLength(2);
  });

  it.each(["create", "update"])("does not let a Dashboard %s block compensation of a visible Project awaiting its first Run", async (operation) => {
    const f = fixture();
    const saved = await f.service.create(input);
    f.frozenCopies.set("unadmitted", ["frozen-subject", "frozen-evaluator"]);
    const command = { name: "Pending", projectIds: ["first", "unadmitted"] };
    const [outcome] = await Promise.allSettled([
      operation === "create"
        ? f.service.create({ ...command, idempotencyKey: "pending" })
        : f.service.update(saved.dashboardId, { ...command, revision: saved.revision }),
    ]);
    expect(await createPostgresProjectStore(f.db, dashboardOwner).deleteUnrun("unadmitted"))
      .toEqual(["frozen-subject", "frozen-evaluator"]);
    expect(outcome).toMatchObject({ status: "rejected", reason: { name: "DashboardProjectNotFoundError", projectId: "unadmitted" } });
    expect(f.projects.has("unadmitted")).toBe(false);
    expect(f.frozenCopies.has("unadmitted")).toBe(false);
    expect(await f.service.list()).toEqual([saved]);
    expect(await f.service.get(saved.dashboardId)).toEqual(saved);
  });

  it("allows new references only after a Run is admitted and leaves that Project and its configuration intact on compensation", async () => {
    const f = fixture();
    const command = { ...input, projectIds: ["unadmitted", "second"] };
    await expect(f.service.create(command)).rejects.toMatchObject({ name: "DashboardProjectNotFoundError", projectId: "unadmitted" });
    f.runs.add("unadmitted");
    f.frozenCopies.set("unadmitted", ["frozen-subject"]);
    const created = await f.service.create(command);
    const updated = await f.service.update(created.dashboardId, { name: "Admitted", projectIds: ["first", "unadmitted"], revision: 1 });
    expect(updated).toMatchObject({ projectIds: ["first", "unadmitted"], revision: 2 });
    expect(await createPostgresProjectStore(f.db, dashboardOwner).deleteUnrun("unadmitted")).toEqual([]);
    expect(f.projects.has("unadmitted")).toBe(true);
    expect(f.frozenCopies.get("unadmitted")).toEqual(["frozen-subject"]);
    expect(await f.service.get(created.dashboardId)).toEqual(updated);
  });

  it("reads old runless references without filtering or rewriting saved configuration", async () => {
    const f = fixture();
    const saved = {
      dashboardId: "00000000-0000-4000-8000-000000000001", name: "Existing", description: "",
      projectIds: ["unadmitted", "first"], revision: 1,
      excludedDataIds: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    f.seedDashboard(saved);
    expect(await f.service.list()).toEqual([saved]);
    expect(await f.service.get(saved.dashboardId)).toEqual(saved);
    expect(await f.service.update(saved.dashboardId, { name: saved.name, projectIds: ["second", "first"], revision: 1 }))
      .toMatchObject({ projectIds: ["second", "first"], revision: 2 });
  });

  it("keeps later soft-deleted Project references readable and permits an atomic repair", async () => {
    const f = fixture();
    const created = await f.service.create(input);
    f.projects.get("second")!.deletedAt = new Date();
    expect(await f.service.get(created.dashboardId)).toEqual(created);
    const repaired = await f.service.update(created.dashboardId, { name: "Repaired", projectIds: ["first", "third"], revision: 1 });
    expect(repaired).toMatchObject({ projectIds: ["first", "third"], revision: 2 });
  });

  it("rejects unknown and foreign Dashboards, including edits, without revealing their configuration", async () => {
    const f = fixture();
    const other = createDashboardService(createPostgresDashboardStore(f.db, "other-owner"));
    const created = await f.service.create(input);
    for (const dashboardId of [created.dashboardId, "00000000-0000-4000-8000-000000000001"]) {
      await expect(other.get(dashboardId)).rejects.toMatchObject({ name: "DashboardNotFoundError", dashboardId });
      await expect(other.update(dashboardId, { name: "Foreign", projectIds: ["first", "second"], revision: 1 }))
        .rejects.toMatchObject({ name: "DashboardNotFoundError", dashboardId });
    }
    expect(await other.list()).toEqual([]);
    expect(await f.service.get(created.dashboardId)).toEqual(created);
  });

  it("allows the same creation key for another owner without crossing Project ownership", async () => {
    const f = fixture();
    f.projects.set("foreign-second", { ownerUserId: "other-owner", deletedAt: null });
    f.runs.add("foreign-second");
    const first = await f.service.create(input);
    const other = createDashboardService(createPostgresDashboardStore(f.db, "other-owner"));
    const second = await other.create({ ...input, projectIds: ["foreign-second", "foreign"] });
    expect(second.dashboardId).not.toBe(first.dashboardId);
    expect(await other.list()).toEqual([second]);
  });

  it("uses the expected revision for concurrent edits and leaves no half replacement after write failure", async () => {
    const f = fixture();
    const created = await f.service.create(input);
    const edits = await Promise.allSettled([
      f.service.update(created.dashboardId, { name: "A", projectIds: ["first", "third"], revision: 1 }),
      f.service.update(created.dashboardId, { name: "B", projectIds: ["third", "second"], revision: 1 }),
    ]);
    expect(edits.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(edits.find((result) => result.status === "rejected")).toMatchObject({
      reason: { name: "DashboardRevisionConflictError" },
    });
    const saved = await f.service.get(created.dashboardId);
    expect(saved.revision).toBe(2);
    const failure = new Error("database write interrupted");
    f.faults.projectInsert = failure;
    await expect(f.service.update(created.dashboardId, { name: "Partial", projectIds: ["second", "first"], revision: 2 }))
      .rejects.toMatchObject({ cause: failure });
    expect(await f.service.get(created.dashboardId)).toEqual(saved);
  });

  it("rolls back the header if association persistence fails and permits retrying the same creation key", async () => {
    const f = fixture();
    const failure = new Error("association persistence interrupted");
    f.faults.projectInsert = failure;
    await expect(f.service.create(input)).rejects.toMatchObject({ cause: failure });
    expect(await f.service.list()).toEqual([]);
    expect(f.snapshot().projects).toEqual([]);
    const created = await f.service.create(input);
    expect(await f.service.get(created.dashboardId)).toEqual(created);
    expect(created.revision).toBe(1);
  });

  it("reads large lists and ordered associations in bounded sets rather than per-Dashboard queries", async () => {
    const f = fixture();
    const ids = Array.from({ length: 1_001 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
    for (const dashboardId of [...ids].reverse()) {
      f.seedDashboard({
        dashboardId, name: dashboardId, description: "", projectIds: ["second", "first"], revision: 1,
        excludedDataIds: [],
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      });
    }
    const result = await f.service.list();
    expect(result.map((dashboard) => dashboard.dashboardId)).toEqual(ids);
    expect(result.every((dashboard) => dashboard.projectIds.join(",") === "second,first")).toBe(true);
    expect(f.queries.filter((query) => query.text.includes(' from "eval_dashboards"'))).toHaveLength(1);
    expect(f.queries.filter((query) => query.text.includes(' from "eval_dashboard_projects"')))
      .toHaveLength([...sqlBatches(ids)].length);
    expect(f.queries.some((query) => query.text.includes(' from "eval_projects" '))).toBe(false);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.releases[0]).toHaveBeenCalledTimes(1);
  });
});
