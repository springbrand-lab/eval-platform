import { RuntimeProjectBusyError } from "@eval-platform/eval-runtime";
import { describe, expect, it, vi } from "vitest";
import type { ApiRuntime, OwnerServices } from "./lib/types.js";
import { EVALUATION_SAMPLING_IDS, METADATA_BODY_BYTES } from "./limits.js";
import { EvalSpApiError, type EvalSpClient } from "./sp/client.js";
import { authorized, jsonRequest, requestApp, WEB_ORIGIN } from "./test-support.js";

const owner = "11111111-1111-4111-8111-111111111111";
const datasetId = "00000000-0000-4000-8000-000000000001";
const outputSchemaId = "00000000-0000-4000-8000-000000000002";
const project = { projectId: "project-1", ownerUserId: owner, name: "Tasks", sourceBranch: "release" };

function setup() {
  const services = {
    catalog: {
      listProjects: vi.fn(async () => [project]),
      createProject: vi.fn(async ({ name }: { name: string }) => ({ ...project, name })),
      getProject: vi.fn(async (projectId: string) => projectId === "project-1"
        ? { ...project, evaluationOutputSchemaId: outputSchemaId }
        : null),
      selectAllSuccessfulSamplingIds: vi.fn(async () => ["sampling-1"]),
    },
    datasets: {
      createDataset: vi.fn(async ({ name }: { name: string }) => ({ datasetId, name })),
      importDataset: vi.fn(async () => ({ dataset: { datasetId, name: "Cases" }, data: [] })),
      exportDataset: vi.fn(async () => "dataset:\n  name: Cases\ndata: []\n"),
    },
    admission: {
      start: vi.fn(async () => ({ runId: "run-1", samplingIds: ["sampling-1"] })),
      evaluate: vi.fn(async () => ({ runId: "run-2", samplingIds: ["sampling-1"] })),
    },
    results: { getRun: vi.fn(async () => ({ runId: "run-1" })) },
    projectRuns: {
      getCurrentRun: vi.fn(async () => null),
      stopRun: vi.fn(async (_projectId: string, runId: string) => runId === "run-1" ? { runId, stopRequested: true as const } : null),
    },
    metrics: { getProjectOverview: vi.fn(async () => ({ projectId: "project-1" })) },
    resources: { createBundle: vi.fn(async () => ({ bundleId: datasetId, name: "A", description: "B" })) },
  };
  const sp = {
    listAgentConfigs: vi.fn(async () => [{ id: "agent-1", user_id: owner, name: "Agent" }]),
    createAgentConfig: vi.fn(async () => { throw new EvalSpApiError(422, { code: "AGENT_CONFIG_INVALID", errMsg: "Name is required" }); }),
  };
  const release = vi.fn();
  const ownerServices = vi.fn(() => ({ services: services as unknown as OwnerServices, release }));
  const runtime: ApiRuntime = {
    webOrigin: WEB_ORIGIN,
    sp: sp as unknown as EvalSpClient,
    serviceAccount: { user: { id: owner, role: "user" }, sessionToken: "service-session" },
    ownerServices,
  };
  return { request: requestApp(runtime), services, sp, ownerServices, release };
}

describe("Eval API HTTP layer", () => {
  it("serves health without a session and wraps success in the SP envelope", async () => {
    const app = setup();
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, msg: { status: "ok" }, errMsg: "", code: "" });
  });

  it("runs every request as the fixed service account without request credentials", async () => {
    const app = setup();
    const anonymous = await app.request("/api/projects");
    const otherToken = await app.request("/api/projects", authorized("someone-else"));
    expect([anonymous.status, otherToken.status]).toEqual([200, 200]);
    expect(app.ownerServices).toHaveBeenNthCalledWith(1, { id: owner, role: "user" }, "service-session");
    expect(app.ownerServices).toHaveBeenNthCalledWith(2, { id: owner, role: "user" }, "service-session");
    const me = await app.request("/api/me");
    expect(await me.json()).toMatchObject({ msg: { id: owner } });
  });

  it("admits only the Eval Web browser origin and keeps CORS headers on failures", async () => {
    const app = setup();
    const foreign = await app.request("/api/projects", authorized("session", { headers: { Origin: "https://other.test" } }));
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ code: "REQUEST_UNTRUSTED_ORIGIN" });
    const preflight = await app.request("/api/projects", {
      method: "OPTIONS", headers: { Origin: WEB_ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
    const failed = await app.request("/api/projects/missing", authorized("session", { headers: { Origin: WEB_ORIGIN } }));
    expect(failed.status).toBe(404);
    expect(failed.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
    expect(failed.headers.get("access-control-expose-headers")).toContain("X-Request-ID");
  });

  it("scopes services to the verified user and releases them after every request", async () => {
    const app = setup();
    const created = await app.request("/api/projects", jsonRequest("POST", { name: " Tasks " }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ success: true, msg: { name: "Tasks" } });
    expect(app.ownerServices).toHaveBeenCalledWith({ id: owner, role: "user" }, "service-session");
    app.services.results.getRun.mockRejectedValueOnce(new Error("database password is secret"));
    const failed = await app.request("/api/runs/run-1", authorized());
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain("secret");
    expect(app.release).toHaveBeenCalledTimes(2);
  });

  it("returns the owned Project", async () => {
    const app = setup();
    const response = await app.request("/api/projects/project-1", authorized());
    const body = await response.json() as { msg: Record<string, unknown> };
    expect(body.msg).toEqual({ ...project, evaluationOutputSchemaId: outputSchemaId });
    expect((await app.request("/api/projects/missing", authorized())).status).toBe(404);
  });

  it("reads every JSON body through one bounded, duplicate-free path before validation", async () => {
    const app = setup();
    const duplicate = await app.request("/api/datasets", jsonRequest("POST", '{"name":"a","nested":{"id":1,"id":2}}'));
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ code: "REQUEST_INVALID_JSON" });
    const invalidUtf8 = await app.request("/api/datasets", { ...jsonRequest("POST", ""), body: new Uint8Array([0xff]) });
    expect(await invalidUtf8.json()).toMatchObject({ code: "REQUEST_INVALID_INPUT" });
    const text = await app.request("/api/datasets", authorized("session", { method: "POST", body: '{"name":"a"}' }));
    expect(text.status).toBe(415);
    const oversized = await app.request("/api/bundles", jsonRequest("POST", {
      name: "a".repeat(METADATA_BODY_BYTES), description: "b",
    }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "REQUEST_PAYLOAD_TOO_LARGE" });
    expect(app.services.datasets.createDataset).not.toHaveBeenCalled();
    expect(app.services.resources.createBundle).not.toHaveBeenCalled();
  });

  it("validates path, query and body with the route schemas", async () => {
    const app = setup();
    const spoofed = await app.request("/api/projects", jsonRequest("POST", { name: "Tasks", ownerUserId: "other" }));
    expect(spoofed.status).toBe(422);
    expect(await spoofed.json()).toMatchObject({ code: "REQUEST_VALIDATION_FAILED", errors: [expect.objectContaining({ path: "" })] });
    expect(app.services.catalog.createProject).not.toHaveBeenCalled();
    expect((await app.request("/api/datasets/not-a-uuid/data", authorized())).status).toBe(422);
    expect((await app.request("/api/samples?dataId=not-a-uuid", authorized())).status).toBe(422);
    expect((await app.request("/api/projects/project-1/samplings/successful?limit=1001", authorized())).status).toBe(422);
    expect((await app.request("/api/projects/project-1/samplings/successful/ids?extra=1", authorized())).status).toBe(422);
    expect((await app.request("/api/datasets/import", authorized("session", { method: "POST", body: "{}" }))).status).toBe(422);
  });

  it("imports raw Dataset documents and exports them with their media type", async () => {
    const app = setup();
    const document = "dataset: { name: Cases }\ndata: []\n";
    const imported = await app.request("/api/datasets/import?format=yaml", authorized("session", { method: "POST", body: document }));
    expect(imported.status).toBe(201);
    expect(app.services.datasets.importDataset).toHaveBeenCalledWith(document, "yaml");
    const exported = await app.request(`/api/datasets/${datasetId}/export?format=yaml`, authorized());
    expect(exported.headers.get("content-type")).toBe("application/yaml; charset=utf-8");
    expect(await exported.text()).toBe("dataset:\n  name: Cases\ndata: []\n");
  });

  it("admits independent evaluation only for a known Project and a bounded unique selection", async () => {
    const app = setup();
    const body = { evaluationConfigId: "judge", samplingIds: ["sampling-1"], idempotencyKey: "click-1" };
    const accepted = await app.request("/api/projects/project-1/evaluations", jsonRequest("POST", body));
    expect(accepted.status).toBe(202);
    expect(app.services.admission.evaluate).toHaveBeenCalledWith({ projectId: "project-1", ...body });
    const missing = await app.request("/api/projects/missing/evaluations", jsonRequest("POST", body));
    expect(await missing.json()).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    const duplicate = await app.request("/api/projects/project-1/evaluations", jsonRequest("POST", { ...body, samplingIds: ["a", "a"] }));
    expect(duplicate.status).toBe(422);
    const tooMany = Array.from({ length: EVALUATION_SAMPLING_IDS + 1 }, (_, index) => `s-${index}`);
    expect((await app.request("/api/projects/project-1/evaluations", jsonRequest("POST", { ...body, samplingIds: tooMany }))).status).toBe(422);
    expect(app.services.admission.evaluate).toHaveBeenCalledTimes(1);
  });

  it("serves the current Run, targeted stop and Run admission conflicts", async () => {
    const app = setup();
    expect(await (await app.request("/api/projects/project-1/runs/current", authorized())).json())
      .toMatchObject({ msg: { run: null } });
    const stopped = await app.request("/api/projects/project-1/runs/run-1/stop", authorized("session", { method: "POST" }));
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toMatchObject({ msg: { runId: "run-1", stopRequested: true } });
    const unknown = await app.request("/api/projects/project-1/runs/old/stop", authorized("session", { method: "POST" }));
    expect(await unknown.json()).toMatchObject({ code: "RUN_NOT_FOUND" });
    app.services.admission.start.mockRejectedValueOnce(new RuntimeProjectBusyError("project-1", "active-run"));
    const busy = await app.request("/api/runs/execution", jsonRequest("POST", {
      idempotencyKey: "new-run", projectId: "project-1", executionConfigId: "config-1",
    }));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({
      code: "PROJECT_BUSY", errMsg: "Project project-1 already has unfinished Run active-run",
    });
  });

  it("passes repeated Run filters to Metrics", async () => {
    const app = setup();
    await app.request("/api/metrics/projects/project-1?runId=run-1&runId=run-2", authorized());
    await app.request("/api/metrics/projects/project-1", authorized());
    expect(app.services.metrics.getProjectOverview.mock.calls).toEqual([
      [{ projectId: "project-1", runIds: ["run-1", "run-2"] }],
      [{ projectId: "project-1" }],
    ]);
  });

  it("proxies Agent Configs with the service session and relays SP validation text", async () => {
    const app = setup();
    const listed = await app.request("/api/agent-configs", authorized());
    expect(await listed.json()).toMatchObject({ msg: [{ id: "agent-1" }] });
    expect(app.sp.listAgentConfigs).toHaveBeenCalledWith("service-session");
    const rejected = await app.request("/api/agent-configs", jsonRequest("POST", { name: "" }));
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ code: "EVAL_SP_REQUEST_INVALID", errMsg: "Name is required" });
  });
});
