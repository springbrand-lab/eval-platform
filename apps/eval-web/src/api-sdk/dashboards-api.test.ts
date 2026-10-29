import { afterEach, expect, it, vi } from "vitest";
import type { DashboardCreateInput, DashboardUpdateInput } from "@eval-platform/eval-contracts";
import { savedDashboard } from "@/test/comparison";

afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  (await import("@/auth/session")).resetAuthForTest();
  vi.resetModules();
});

it("reads saved dashboards through the shared client with cancellation and separate directory/detail keys", async () => {
  const { api } = await import("./client");
  const read = vi.spyOn(api, "get").mockResolvedValue([]);
  const { dashboardKeys, getDashboard, listDashboards } = await import("./dashboards-api");
  const signal = new AbortController().signal;
  await listDashboards(signal);
  await getDashboard("dashboard /中文", signal);
  expect(read.mock.calls).toEqual([
    ["/api/dashboards", { signal }],
    ["/api/dashboards/dashboard%20%2F%E4%B8%AD%E6%96%87", { signal }],
  ]);
  expect(dashboardKeys.detail("one")).not.toEqual(dashboardKeys.list());
  expect(dashboardKeys.detail("two")).not.toEqual(dashboardKeys.detail("one"));
});

it("forwards the captured create body and revision-checked update without inventing client IDs or analysis", async () => {
  const { api } = await import("./client");
  const post = vi.spyOn(api, "post").mockResolvedValue({});
  const put = vi.spyOn(api, "put").mockResolvedValue({});
  const { createDashboard, updateDashboard } = await import("./dashboards-api");
  const create: DashboardCreateInput = { name: "质量观察", description: "两侧当前结果", projectIds: ["p2", "p1"], idempotencyKey: "dashboard-request" };
  const update: DashboardUpdateInput = { name: "质量复核", description: "", projectIds: ["p2", "p3"], revision: 4 };
  await createDashboard(create);
  await updateDashboard("saved /看板", update);
  expect(post).toHaveBeenCalledExactlyOnceWith("/api/dashboards", create);
  expect(post.mock.calls[0][1]).toBe(create);
  expect(put).toHaveBeenCalledExactlyOnceWith("/api/dashboards/saved%20%2F%E7%9C%8B%E6%9D%BF", update);
});

it("unwraps a 201 create envelope and an updated revision using the normal authenticated transport", async () => {
  const request: DashboardCreateInput = { name: "发布观察", description: "", projectIds: ["p2", "p1"], idempotencyKey: "stable-dashboard-request" };
  const created = savedDashboard({ name: request.name, description: "", projectIds: request.projectIds });
  const updated = { ...created, name: "发布复核", revision: 2 };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = new Request(input, init);
    expect(call.headers.get("Authorization")).toBe("Bearer synthetic-dashboard-token");
    if (call.method === "POST") {
      expect(new URL(call.url).pathname).toBe("/api/dashboards");
      expect(await call.json()).toEqual(request);
      return Response.json({ success: true, msg: created }, { status: 201 });
    }
    expect(call.method).toBe("PUT");
    expect(new URL(call.url).pathname).toBe(`/api/dashboards/${created.dashboardId}`);
    expect(await call.json()).toEqual({ name: updated.name, description: "", projectIds: ["p2", "p1"], revision: 1 });
    return Response.json({ success: true, msg: updated });
  });
  vi.stubGlobal("fetch", fetcher);
  (await import("@/auth/session")).resetAuthForTest({ status: "ready", token: "synthetic-dashboard-token" });
  const { createDashboard, updateDashboard } = await import("./dashboards-api");
  await expect(createDashboard(request)).resolves.toEqual(created);
  await expect(updateDashboard(created.dashboardId, { name: updated.name, description: "", projectIds: ["p2", "p1"], revision: 1 })).resolves.toEqual(updated);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
