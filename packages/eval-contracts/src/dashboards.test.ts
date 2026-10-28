import { expect, it } from "vitest";
import { dashboardCreateSchema, dashboardSchema, dashboardUpdateSchema } from "./index.js";

it("creates a named Dashboard configuration with ordered Projects, not a metrics snapshot", () => {
  const input = { name: "  模型方案对比  ", projectIds: ["project-b", "project-a"], idempotencyKey: "create-dashboard-1" };
  expect(dashboardCreateSchema.parse(input)).toEqual({
    name: "模型方案对比", description: "", projectIds: ["project-b", "project-a"], idempotencyKey: "create-dashboard-1",
  });
  for (const patch of [
    { name: " " }, { projectIds: ["project-a"] }, { projectIds: ["project-a", "project-a"] },
    { idempotencyKey: "" }, { summary: {} }, { scores: [1, 2] }, { datasetId: "dataset" },
  ]) expect(dashboardCreateSchema.safeParse({ ...input, ...patch }).success).toBe(false);
});

it("requires the known configuration revision for a full replacement without a new creation identity", () => {
  const input = { name: "模型对比", projectIds: ["project-b", "project-a"], revision: 3 };
  expect(dashboardUpdateSchema.parse(input)).toEqual({ ...input, description: "" });
  for (const patch of [
    { revision: undefined }, { revision: 0 }, { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { idempotencyKey: "create-again" }, { ownerUserId: "other" },
  ]) expect(dashboardUpdateSchema.safeParse({ ...input, ...patch }).success).toBe(false);
});

it("reads a durable configuration identity without admitting copied comparison results", () => {
  const input = {
    dashboardId: "ABCDEF00-0000-4000-8000-000000000001",
    name: "模型对比", description: "", projectIds: ["project-b", "project-a"], revision: 2,
    createdAt: "2026-10-28T08:00:00.000Z", updatedAt: "2026-10-28T09:00:00.000Z",
  };
  expect(dashboardSchema.parse(input)).toEqual({ ...input, dashboardId: input.dashboardId.toLowerCase() });
  for (const patch of [{ dashboardId: "invalid" }, { updatedAt: "yesterday" }, { metrics: [] }, { sampling: {} }]) {
    expect(dashboardSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  }
});
