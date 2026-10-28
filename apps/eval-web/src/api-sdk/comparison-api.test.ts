import { afterEach, expect, it, vi } from "vitest";
import type { ProjectComparisonQuery } from "@eval-platform/eval-metrics";
import { comparisonView } from "@/test/comparison";

afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  (await import("@/auth/session")).resetAuthForTest();
  vi.resetModules();
});

it("reads a comparison through the shared client with repeated Project identities and an abort signal", async () => {
  const { api } = await import("./client");
  const { getProjectComparison } = await import("./comparison-api");
  const read = vi.spyOn(api, "get").mockResolvedValue({ rows: [] });
  const query: ProjectComparisonQuery = {
    projectIds: ["project /甲", "project /乙"], datasetId: "dataset /共享", jsonPointer: "/quality/score",
  };
  const signal = new AbortController().signal;
  await expect(getProjectComparison(query, signal)).resolves.toEqual({ rows: [] });
  expect(read).toHaveBeenCalledExactlyOnceWith("/api/metrics/comparison", {
    params: { projectId: query.projectIds, datasetId: query.datasetId, jsonPointer: query.jsonPointer }, signal,
  });
});

it("keeps the project order, Dataset and metric in distinct cache scopes, including the root metric", async () => {
  const { comparisonKeys } = await import("./comparison-api");
  const query: ProjectComparisonQuery = { projectIds: ["a", "b"] };
  const all = comparisonKeys.view(query);
  expect(comparisonKeys.view({ ...query, projectIds: ["b", "a"] })).not.toEqual(all);
  expect(comparisonKeys.view({ ...query, datasetId: "one" })).not.toEqual(all);
  expect(comparisonKeys.view({ ...query, jsonPointer: "" })).not.toEqual(all);
  expect(comparisonKeys.view({ ...query, jsonPointer: "/score" })).not.toEqual(all);
  expect(comparisonKeys.view({ ...query, excludedDataIds: ["data-1"] })).not.toEqual(all);
});

it("reads a confirmed exclusion scope as JSON, keeping the full Data set out of URL limits", async () => {
  const { api } = await import("./client");
  const { getProjectComparison } = await import("./comparison-api");
  const read = vi.spyOn(api, "post").mockResolvedValue({ rows: [] });
  const query: ProjectComparisonQuery = { projectIds: ["a", "b"], excludedDataIds: ["data-1"] };
  const signal = new AbortController().signal;
  await expect(getProjectComparison(query, signal)).resolves.toEqual({ rows: [] });
  expect(read).toHaveBeenCalledExactlyOnceWith("/api/metrics/comparison", query, { signal });
});

it("encodes repeated projectId query parameters and unwraps the standard envelope without a browser aggregation fallback", async () => {
  const view = comparisonView();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(request.method).toBe("GET");
    expect(request.headers.get("Authorization")).toBe("Bearer synthetic-token");
    expect(url.pathname).toBe("/api/metrics/comparison");
    expect(url.searchParams.getAll("projectId")).toEqual(["project /甲", "project /乙"]);
    expect(url.searchParams.get("datasetId")).toBe("dataset /共享");
    expect(url.searchParams.get("jsonPointer")).toBe("");
    return Response.json({ success: true, msg: view });
  });
  vi.stubGlobal("fetch", fetcher);
  (await import("@/auth/session")).resetAuthForTest({ status: "ready", token: "synthetic-token" });
  const { getProjectComparison } = await import("./comparison-api");
  await expect(getProjectComparison({ projectIds: ["project /甲", "project /乙"], datasetId: "dataset /共享", jsonPointer: "" })).resolves.toEqual(view);
  expect(fetcher).toHaveBeenCalledOnce();
});
