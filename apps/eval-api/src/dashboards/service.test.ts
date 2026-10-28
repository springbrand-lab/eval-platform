import type { Dashboard, DashboardInput } from "@eval-platform/eval-contracts";
import { describe, expect, it, vi } from "vitest";
import { COMPARISON_PROJECTS } from "../limits.js";
import type { DashboardStore } from "./store.js";
import { createDashboardService } from "./service.js";

const dashboard: Dashboard = {
  excludedDataIds: [],
  dashboardId: "abcdef00-0000-4000-8000-000000000001",
  name: "Board", description: "", projectIds: ["second", "first"], revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

function fixture() {
  const store = {
    list: vi.fn(async () => [dashboard]),
    get: vi.fn(async (_id: string): Promise<Dashboard | null> => dashboard),
    create: vi.fn(async (_input: DashboardInput, _creation: { readonly key: string; readonly fingerprint: string }) => dashboard),
    update: vi.fn(async (_id: string, _input: DashboardInput, _revision: number) => dashboard),
  } satisfies DashboardStore;
  return { store, service: createDashboardService(store) };
}

describe("Dashboards application service", () => {
  it("normalizes a creation once and binds the ordered configuration to its original fingerprint", async () => {
    const { service, store } = fixture();
    const input = { name: " Board ", projectIds: ["second", "first"], idempotencyKey: "create" };
    expect(await service.create(input)).toBe(dashboard);
    await service.create({ ...input, name: "Board", description: "  " });
    const [first, replay] = store.create.mock.calls;
    expect(first).toEqual([
      { name: "Board", description: "", projectIds: ["second", "first"] },
      { key: "create", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    ]);
    expect(replay).toEqual(first);
    await service.create({ ...input, excludedDataIds: [] });
    expect(store.create.mock.calls.at(-1)).toEqual(first);
    await service.create({ ...input, projectIds: ["first", "second"] });
    expect(store.create.mock.calls.at(-1)?.[1].fingerprint).not.toBe(first?.[1].fingerprint);
  });

  it("passes the expected revision and canonical UUID to one atomic replacement", async () => {
    const { service, store } = fixture();
    await service.update(dashboard.dashboardId.toUpperCase(), { name: " Updated ", projectIds: ["first", "second"], revision: 3 });
    expect(store.update).toHaveBeenCalledExactlyOnceWith(
      dashboard.dashboardId, { name: "Updated", description: "", projectIds: ["first", "second"] }, 3,
    );
    expect(store.create).not.toHaveBeenCalled();
  });

  it("lists and reopens the persisted projection without recomputing Metrics", async () => {
    const { service, store } = fixture();
    expect(await service.list()).toEqual([dashboard]);
    expect(await service.get(dashboard.dashboardId.toUpperCase())).toBe(dashboard);
    expect(store.get).toHaveBeenCalledExactlyOnceWith(dashboard.dashboardId);
    store.get.mockResolvedValueOnce(null);
    await expect(service.get(dashboard.dashboardId)).rejects.toMatchObject({ name: "DashboardNotFoundError" });
  });

  it.each([
    { projectIds: ["first"] },
    { projectIds: ["first", "first"] },
    { projectIds: Array.from({ length: COMPARISON_PROJECTS + 1 }, (_, index) => `project-${index}`) },
    { projectIds: ["first", "invalid/id"] },
    { projectIds: ["first", " second"] },
    { name: " " },
    { ownerUserId: "other" },
    { jsonPointer: "/score" },
    { results: [] },
  ])("rejects invalid configuration at the service boundary: %j", async (change) => {
    const { service, store } = fixture();
    const input = { name: "Board", projectIds: ["first", "second"], idempotencyKey: "create", ...change };
    await expect(service.create(input)).rejects.toMatchObject({ name: "ZodError" });
    expect(store.create).not.toHaveBeenCalled();
  });
});
