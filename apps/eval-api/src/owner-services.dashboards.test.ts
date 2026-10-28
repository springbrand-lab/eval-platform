import { dashboardSchema, evalInputLimitsSchema, type Dashboard } from "@eval-platform/eval-contracts";
import { describe, expect, it, vi } from "vitest";
import { dashboardOwner, dashboardsDriver } from "./db/dashboards.test-support.js";
import { createRouter } from "./lib/create-app.js";
import type { ApiRuntime } from "./lib/types.js";
import { COMPARISON_PROJECTS, IDENTIFIER_CHARS, JSON_BODY_BYTES } from "./limits.js";
import { createOwnerServices } from "./owner-services.js";
import dashboardRouter from "./routes/dashboards/dashboards.index.js";
import { createEvalSpClient } from "./sp/client.js";
import { createSpObservationClient } from "./sp/observation.js";
import { jsonRequest, requestApp, WEB_ORIGIN } from "./test-support.js";

const input = { name: " Board ", description: " Notes ", projectIds: ["second", "first"], idempotencyKey: "create" };
const unknownId = "abcdef00-0000-4000-8000-000000000001";

function fixture() {
  const driver = dashboardsDriver();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error("Dashboards must not contact SP"); });
  const sideEffect = vi.fn(async (): Promise<never> => { throw new Error("Dashboards must not use bundles or a queue"); });
  const sp = createEvalSpClient({ origin: "https://eval.test", writeOrigin: WEB_ORIGIN, fetch });
  const webApiToken = "w".repeat(40);
  const headers = { "X-Eval-Web-Token": webApiToken, Origin: WEB_ORIGIN };
  const runtime: ApiRuntime = {
    webOrigin: WEB_ORIGIN, webApiToken, sp, spAdminToken: "unused",
    serviceAccount: { user: { id: dashboardOwner, role: "user" }, email: "eval@example.test", sessionToken: "fixed-session" },
    observation: createSpObservationClient({
      apiOrigin: "https://eval.test", agentOrigin: "https://agent.test", trustedOrigin: WEB_ORIGIN,
      sessionToken: "fixed-session", fetch,
    }),
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
  const send = (method: string, body: unknown) => jsonRequest(method, body, undefined, headers);
  return Object.assign(driver, { fetch, sideEffect, headers, send, request: requestApp(runtime) });
}

async function saved(response: Response): Promise<Dashboard> {
  const body = await response.json();
  expect(body).toMatchObject({ success: true, errMsg: "", code: "" });
  return dashboardSchema.parse(body.msg);
}

describe("persisted Dashboards through HTTP and real owner services", () => {
  it("creates, lists, reopens and edits one saved configuration, with original-command replay after edits", async () => {
    const f = fixture();
    const response = await f.request("/api/dashboards", f.send("POST", input));
    expect(response.status).toBe(201);
    const created = await saved(response);
    expect(created).toMatchObject({ name: "Board", description: "Notes", projectIds: ["second", "first"], revision: 1 });
    const list = await f.request("/api/dashboards", { headers: f.headers });
    expect(await list.json()).toEqual({ success: true, msg: [created], errMsg: "", code: "" });
    const path = `/api/dashboards/${created.dashboardId.toUpperCase()}`;
    expect(await saved(await f.request(path, { headers: f.headers }))).toEqual(created);
    const edited = await f.request(path, f.send("PUT", { name: " Edited ", projectIds: ["third", "first"], revision: 1 }));
    expect(edited.status).toBe(200);
    const updated = await saved(edited);
    expect(updated).toMatchObject({ dashboardId: created.dashboardId, name: "Edited", description: "", revision: 2, projectIds: ["third", "first"] });
    expect(await saved(await f.request(path, { headers: f.headers }))).toEqual(updated);
    const replay = await f.request("/api/dashboards", f.send("POST", { ...input, name: "Board", description: "Notes" }));
    expect(replay.status).toBe(201);
    expect(await saved(replay)).toEqual(updated);
    const conflict = await f.request("/api/dashboards", f.send("POST", { ...input, name: "Edited" }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "DASHBOARD_IDEMPOTENCY_CONFLICT" });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sideEffect).not.toHaveBeenCalled();
  });

  it("converges concurrent creates and applies only one edit for a shared revision", async () => {
    const f = fixture();
    const creations = await Promise.all([
      f.request("/api/dashboards", f.send("POST", input)),
      f.request("/api/dashboards", f.send("POST", input)),
    ]);
    expect(creations.map((response) => response.status)).toEqual([201, 201]);
    const [first, replay] = await Promise.all(creations.map(saved));
    expect(replay).toEqual(first);
    const updates = await Promise.all(["A", "B"].map((name) => f.request(`/api/dashboards/${first!.dashboardId}`,
      f.send("PUT", { name, projectIds: ["first", "third"], revision: 1 }))));
    expect(updates.map((response) => response.status).sort()).toEqual([200, 409]);
    const conflict = updates.find((response) => response.status === 409)!;
    expect(await conflict.json()).toMatchObject({ code: "DASHBOARD_REVISION_CONFLICT" });
    expect(f.snapshot().dashboards.size).toBe(1);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sideEffect).not.toHaveBeenCalled();
  });

  it.each(["unknown", "foreign", "deleted", "unadmitted"])("returns a safe Project error and rolls back all writes for %s", async (projectId) => {
    const f = fixture();
    for (const projectIds of [["first", projectId], [projectId, "first"]]) {
      const response = await f.request("/api/dashboards", f.send("POST", { ...input, projectIds }));
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toMatchObject({ code: "PROJECT_NOT_FOUND", errMsg: "Project not found" });
      expect(body).not.toHaveProperty("msg");
      expect(JSON.stringify(body)).not.toContain("other-owner");
      expect(f.snapshot().dashboards.size).toBe(0);
    }
    const created = await saved(await f.request("/api/dashboards", f.send("POST", input)));
    const update = await f.request(`/api/dashboards/${created.dashboardId}`, f.send("PUT", {
      name: "Invalid update", projectIds: ["first", projectId], revision: 1,
    }));
    expect(update.status).toBe(404);
    expect(await update.json()).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(await saved(await f.request(`/api/dashboards/${created.dashboardId}`, { headers: f.headers }))).toEqual(created);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sideEffect).not.toHaveBeenCalled();
  });

  it("keeps saved references after a Project soft delete and permits editing them out", async () => {
    const f = fixture();
    const created = await saved(await f.request("/api/dashboards", f.send("POST", input)));
    f.projects.get("second")!.deletedAt = new Date();
    const path = `/api/dashboards/${created.dashboardId}`;
    expect(await saved(await f.request(path, { headers: f.headers }))).toEqual(created);
    const repaired = await f.request(path, f.send("PUT", { name: "Fixed", projectIds: ["first", "third"], revision: 1 }));
    expect(repaired.status).toBe(200);
    expect(await saved(repaired)).toMatchObject({ projectIds: ["first", "third"], revision: 2 });
  });

  it("hides unknown and foreign Dashboards for reads and edits, independently of actor or Authorization", async () => {
    const f = fixture();
    f.projects.set("foreign-second", { ownerUserId: "other-owner", deletedAt: null });
    f.seedDashboard({
      dashboardId: unknownId, name: "Private configuration", description: "Private description",
      projectIds: ["foreign", "foreign-second"], revision: 5,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }, "other-owner");
    for (const dashboardId of [unknownId, "00000000-0000-4000-8000-000000000001"]) {
      const headers = {
        ...f.headers, "Content-Type": "application/json", Authorization: "Bearer other-owner",
        "X-Eval-Actor": encodeURIComponent(JSON.stringify({ id: "other-owner", name: "Other" })),
      };
      for (const init of [{ headers }, { ...f.send("PUT", { name: "Overwrite", projectIds: ["first", "second"], revision: 5 }), headers }]) {
        const response = await f.request(`/api/dashboards/${dashboardId}`, init);
        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body).toMatchObject({ code: "DASHBOARD_NOT_FOUND", errMsg: "Dashboard not found" });
        expect(body).not.toHaveProperty("msg");
        expect(JSON.stringify(body)).not.toContain("Private");
      }
    }
    expect((await (await f.request("/api/dashboards", { headers: f.headers })).json()).msg).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sideEffect).not.toHaveBeenCalled();
  });

  it("enforces the published Project count and path-safe entity IDs, without hard-coding a second limit", async () => {
    const f = fixture();
    const bounds = evalInputLimitsSchema.parse((await (await f.request("/api/input-limits", { headers: f.headers })).json()).msg);
    expect(bounds.comparisonProjects).toBe(COMPARISON_PROJECTS);
    const projectIds = Array.from({ length: bounds.comparisonProjects }, (_, index) => `project-${index}`);
    for (const projectId of projectIds) {
      f.projects.set(projectId, { ownerUserId: dashboardOwner, deletedAt: null });
      f.runs.add(projectId);
    }
    const maximum = await f.request("/api/dashboards", f.send("POST", { ...input, projectIds }));
    expect(maximum.status).toBe(201);
    expect((await saved(maximum)).projectIds).toEqual(projectIds);
    for (const invalid of [
      [...projectIds, "too-many"], ["first"], ["first", "first"], ["first", ""], ["first", " second"],
      ["first", "second/third"], ["first", "bad\u0000"], ["first", "x".repeat(IDENTIFIER_CHARS + 1)],
    ]) {
      const response = await f.request("/api/dashboards", f.send("POST", { ...input, projectIds: invalid }));
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "REQUEST_VALIDATION_FAILED" });
    }
  });

  it("rejects unknown body/query fields, invalid UUIDs and invalid revisions before any SQL", async () => {
    const f = fixture();
    for (const change of [
      { ownerUserId: "other" }, { results: [] }, { jsonPointer: "/score" }, { datasetId: "dataset" },
      { metric: "score" }, { dashboardId: unknownId }, { revision: 1 }, { name: " " }, { idempotencyKey: "bad\u0000" },
    ]) {
      const response = await f.request("/api/dashboards", f.send("POST", { ...input, ...change }));
      expect(response.status).toBe(422);
    }
    for (const revision of [undefined, 0, -1, 1.5, "1"]) {
      const response = await f.request(`/api/dashboards/${unknownId}`, f.send("PUT", { name: "Edit", projectIds: ["first", "second"], revision }));
      expect(response.status).toBe(422);
    }
    expect((await f.request(`/api/dashboards/${unknownId}`, f.send("PUT", { ...input, revision: 1 }))).status).toBe(422);
    for (const [path, init] of [
      ["/api/dashboards?ownerUserId=other", { headers: f.headers }],
      ["/api/dashboards?unexpected=", f.send("POST", input)],
      [`/api/dashboards/${unknownId}?projectId=first`, { headers: f.headers }],
      [`/api/dashboards/${unknownId}?metric=score`, f.send("PUT", { name: "Edit", projectIds: ["first", "second"], revision: 1 })],
      ["/api/dashboards/not-a-uuid", { headers: f.headers }],
    ] as const) expect((await f.request(path, init)).status).toBe(422);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sideEffect).not.toHaveBeenCalled();
  });

  it("uses the common bounded JSON reader for media type, malformed/duplicate fields and body size", async () => {
    const f = fixture();
    for (const [body, mediaType, status, code] of [
      [JSON.stringify(input), "text/plain", 415, "REQUEST_UNSUPPORTED_MEDIA_TYPE"],
      ["{", "application/json", 400, "REQUEST_INVALID_JSON"],
      ['{"name":"One","name":"Two"}', "application/json", 400, "REQUEST_INVALID_JSON"],
      ["[]", "application/json", 400, "REQUEST_INVALID_JSON"],
      [new Uint8Array([0xff]), "application/json", 400, "REQUEST_INVALID_INPUT"],
      [JSON.stringify({ ...input, name: "x".repeat(JSON_BODY_BYTES) }), "application/json", 413, "REQUEST_PAYLOAD_TOO_LARGE"],
    ] as const) {
      const response = await f.request("/api/dashboards", { method: "POST", headers: { ...f.headers, "Content-Type": mediaType }, body });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    }
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("keeps every Dashboard route behind the gateway and trusted-Origin boundary", async () => {
    const f = fixture();
    for (const [path, init] of [
      ["/api/dashboards", {}],
      ["/api/dashboards", f.send("POST", input)],
      [`/api/dashboards/${unknownId}`, {}],
      [`/api/dashboards/${unknownId}`, f.send("PUT", { name: "Edit", projectIds: ["first", "second"], revision: 1 })],
    ] as const) {
      expect((await f.request(path, { ...init, headers: { "Content-Type": "application/json" } })).status).toBe(401);
      expect((await f.request(path, { ...init, headers: { ...f.headers, "Content-Type": "application/json", Origin: "https://other.test" } })).status).toBe(403);
    }
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sideEffect).not.toHaveBeenCalled();
  });

  it("generates OpenAPI for all four concrete Dashboard DTO routes", () => {
    const app = createRouter();
    app.route("/api/dashboards", dashboardRouter);
    const document = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "Eval API", version: "1" } });
    const collection = document.paths?.["/api/dashboards"];
    expect(collection?.get?.responses).toHaveProperty("200");
    expect(collection?.post).toMatchObject({
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          description: { type: "string", maxLength: 2_000, default: "" },
          projectIds: { type: "array", minItems: 2, maxItems: COMPARISON_PROJECTS },
          idempotencyKey: { type: "string", maxLength: 200 },
        },
      } } } },
      responses: { 201: expect.any(Object), 404: expect.any(Object), 409: expect.any(Object), 413: expect.any(Object), 422: expect.any(Object) },
    });
    const entity = document.paths?.["/api/dashboards/{dashboardId}"];
    expect(entity?.get).toMatchObject({ parameters: [{ in: "path", name: "dashboardId", required: true, schema: { type: "string", format: "uuid" } }] });
    expect(entity?.put).toMatchObject({
      responses: { 200: expect.any(Object), 404: expect.any(Object), 409: expect.any(Object), 422: expect.any(Object) },
    });
  });
});
