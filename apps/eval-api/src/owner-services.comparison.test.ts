import { describe, expect, it, vi } from "vitest";
import { metricsDriver, metricsOwner } from "./db/metrics.test-support.js";
import type { ApiRuntime } from "./lib/types.js";
import { createOwnerServices } from "./owner-services.js";
import { createEvalSpClient } from "./sp/client.js";
import { createSpObservationClient } from "./sp/observation.js";
import { requestApp, WEB_ORIGIN } from "./test-support.js";
import { JSON_BODY_BYTES } from "./limits.js";

function fixture() {
  const driver = metricsDriver([
    { projectId: "first" }, { projectId: "second" },
    { projectId: "foreign", ownerUserId: "other-owner" }, { projectId: "deleted", deleted: true },
  ]);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error("Comparison must not contact SP"); });
  const sideEffect = vi.fn(async (): Promise<never> => { throw new Error("Comparison must not write or read bundles"); });
  const sp = createEvalSpClient({ origin: "https://eval.test", writeOrigin: WEB_ORIGIN, fetch });
  const webApiToken = "w".repeat(40);
  const runtime: ApiRuntime = {
    webOrigin: WEB_ORIGIN,
    webApiToken,
    sp,
    spAdminToken: "unused",
    observation: createSpObservationClient({
      apiOrigin: "https://eval.test", agentOrigin: "https://agent.test", trustedOrigin: WEB_ORIGIN,
      sessionToken: "fixed-session", fetch,
    }),
    serviceAccount: { user: { id: metricsOwner, role: "user" }, email: "eval@example.test", sessionToken: "fixed-session" },
    ownerServices: createOwnerServices({
      db: driver.db, sp, release: { sourceBranch: "release", sourceCommit: "a".repeat(40) },
      runQueue: { enqueue: sideEffect },
      bundles: {
        resolveInitialMaterials: sideEffect, resolveInitialSession: sideEffect,
        uploadInitialMaterials: sideEffect, uploadInitialSession: sideEffect,
        removeInitialMaterials: sideEffect, removeInitialSession: sideEffect,
      },
    }),
  };
  const headers = { "X-Eval-Web-Token": webApiToken, Origin: WEB_ORIGIN };
  return { ...driver, fetch, sideEffect, headers, request: requestApp(runtime) };
}

describe("comparison through real owner-service composition", () => {
  it("accepts a bounded exclusion set in a read-only JSON comparison without URL-sized identity lists", async () => {
    const f = fixture();
    const response = await f.request("/api/metrics/comparison", {
      method: "POST", headers: { ...f.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ projectIds: ["first", "second"], excludedDataIds: ["data-1"], jsonPointer: "" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, msg: { rows: [] } });
    expect(f.queries[0]?.text).toBe("begin isolation level repeatable read read only");
    expect(f.queries.at(-1)?.text).toBe("commit");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sideEffect).not.toHaveBeenCalled();
    for (const patch of [{ excludedDataIds: ["data-1", "data-1"] }, { excludedDataIds: "data-1" }, { scores: [] }]) {
      const invalid = await f.request("/api/metrics/comparison", {
        method: "POST", headers: { ...f.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ projectIds: ["first", "second"], ...patch }),
      });
      expect(invalid.status).toBe(422);
    }
  });

  it("guards JSON comparison bodies and owner scope before returning any selected Data", async () => {
    const f = fixture();
    const path = "/api/metrics/comparison";
    const send = (body: unknown, headers = f.headers) => f.request(path, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await send({ projectIds: ["first", "second"] }, { ...f.headers, Origin: "https://foreign.test" })).status).toBe(403);
    expect((await send({ projectIds: ["first", "second"], excludedDataIds: ["x".repeat(JSON_BODY_BYTES)] })).status).toBe(413);
    expect(f.connect).not.toHaveBeenCalled();
    expect((await send({ projectIds: ["first", "foreign"], excludedDataIds: ["data-1"] })).status).toBe(404);
    expect(f.queries.at(-1)?.text).toBe("rollback");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sideEffect).not.toHaveBeenCalled();
  });

  it("returns the Metrics empty-intersection projection from one owner-scoped SQL snapshot without side effects", async () => {
    const f = fixture();
    const response = await f.request("/api/metrics/comparison?projectId=second&projectId=first&jsonPointer=", { headers: f.headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true, code: "", errMsg: "",
      msg: {
        projects: [
          { project: { projectId: "second", ownerUserId: metricsOwner } },
          { project: { projectId: "first", ownerUserId: metricsOwner } },
        ],
        fields: [], selectedField: null, datasets: [], datasetId: null, rows: [],
        summary: [
          { projectId: "second", dataCount: 0, samplingCount: 0, evaluationCount: 0, score: null },
          { projectId: "first", dataCount: 0, samplingCount: 0, evaluationCount: 0, score: null },
        ],
      },
    });
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.queries[0]?.text).toBe("begin isolation level repeatable read read only");
    expect(f.queries.at(-1)?.text).toBe("commit");
    expect(f.releases[0]).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sideEffect).not.toHaveBeenCalled();
  });

  it.each(["unknown", "foreign", "deleted"])("returns no partial view when either selected Project is %s", async (inaccessible) => {
    for (const projectIds of [["first", inaccessible], [inaccessible, "first"]]) {
      const f = fixture();
      const query = new URLSearchParams(projectIds.map((projectId) => ["projectId", projectId]));
      const response = await f.request(`/api/metrics/comparison?${query}`, { headers: {
        ...f.headers, Authorization: "Bearer other-owner",
        "X-Eval-Actor": encodeURIComponent(JSON.stringify({ id: "other-owner", name: "Other" })),
      } });
      expect(response.status).toBe(404);
      const error = await response.json();
      expect(error).toMatchObject({ code: "PROJECT_NOT_FOUND", requestId: expect.any(String) });
      expect(error).not.toHaveProperty("msg");
      expect(JSON.stringify(error)).not.toContain('"ownerUserId"');
      expect(f.connect).toHaveBeenCalledTimes(1);
      expect(f.queries.at(-1)?.text).toBe("rollback");
      expect(f.releases[0]).toHaveBeenCalledTimes(1);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.sideEffect).not.toHaveBeenCalled();
    }
  });

  it("relays the real Metrics JSON Pointer error before opening a database snapshot", async () => {
    const f = fixture();
    const response = await f.request("/api/metrics/comparison?projectId=first&projectId=second&jsonPointer=not-a-pointer", { headers: f.headers });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "METRICS_QUERY_INVALID" });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sideEffect).not.toHaveBeenCalled();
  });

  it("rejects untrusted or unauthenticated requests and unknown query parameters before any SQL or SP access", async () => {
    const f = fixture();
    const path = "/api/metrics/comparison?projectId=first&projectId=second";
    const unauthenticated = await f.request(path);
    expect(unauthenticated.status).toBe(401);
    const untrusted = await f.request(path, { headers: { ...f.headers, Origin: "https://other.test" } });
    expect(untrusted.status).toBe(403);
    const unknown = await f.request(`${path}&baseline=first`, { headers: f.headers });
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({ code: "REQUEST_VALIDATION_FAILED" });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sideEffect).not.toHaveBeenCalled();
  });
});
