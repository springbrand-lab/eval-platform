import { RuntimeAdmissionConflictError, RuntimeInputError, RuntimeProjectBusyError } from "@eval-platform/eval-runtime";
import { describe, expect, it, vi } from "vitest";
import { AgentConfigFrozenError, ProjectEvaluationPlanLockedError } from "./db/errors.js";
import type { ApiRuntime, OwnerServices } from "./lib/types.js";
import { METADATA_BODY_BYTES, RUN_TARGET_IDS, SAMPLING_COUNT_MAX, ZIP_BODY_BYTES } from "./limits.js";
import { EvalSpApiError, EvalSpTransportError, type EvalSpClient } from "./sp/client.js";
import { authorized, jsonRequest, requestApp, WEB_ORIGIN } from "./test-support.js";

const owner = "11111111-1111-4111-8111-111111111111";
const datasetId = "00000000-0000-4000-8000-000000000001";
const outputSchemaId = "00000000-0000-4000-8000-000000000002";
const agentId = "00000000-0000-4000-8000-000000000003";
const project = { projectId: "project-1", ownerUserId: owner, name: "Tasks", sourceBranch: "release", createdAt: "2026-01-01T00:00:00.000Z" };
const view = { project, datasets: [], projectSamples: [], currentRun: null, evaluation: null };
const evaluationPlan = { userAgentId: agentId, evaluationConcurrency: 1, outputSchemaId };
const createBody = {
  name: " Tasks ",
  datasets: [{ datasetId: datasetId.toUpperCase() }],
  samplingCount: 2,
  execution: { userAgentId: agentId, framework: "sp", executionConcurrency: 2 },
  idempotencyKey: "create-1",
  run: { operation: "execution" },
};
const preview = {
  projectId: "project-1", operation: "execution", selector: { all: true },
  targets: { projectSampleIds: ["sample-1"], samplingIds: [] as string[] },
  replacedSamplingCount: 0, newSamplingCount: 1, evaluationCount: 0, executionPlanDigest: "d", evaluationPlanDigest: null,
};

function setup() {
  const services = {
    projects: {
      list: vi.fn(async () => [project]),
      create: vi.fn(async (body: { name: string }) => ({ project: { ...project, name: body.name }, run: { runId: "run-1", samplingIds: ["s-1"] } })),
      get: vi.fn(async (projectId: string) => projectId === "project-1" ? view : null),
      exists: vi.fn(async (projectId: string) => projectId === "project-1"),
      delete: vi.fn(async () => undefined),
      replaceEvaluationPlan: vi.fn(async () => view),
    },
    datasets: {
      createDataset: vi.fn(async ({ name }: { name: string }) => ({ datasetId, name })),
      importDataset: vi.fn(async () => ({ dataset: { datasetId, name: "Cases" }, data: [] })),
      exportDataset: vi.fn(async () => "dataset:\n  name: Cases\ndata: []\n"),
    },
    admission: {
      preview: vi.fn(async () => preview),
      submit: vi.fn(async () => ({ runId: "run-2", samplingIds: ["s-2"] })),
    },
    results: { getRun: vi.fn(async () => ({ runId: "run-1" })) },
    projectRuns: {
      getCurrentRun: vi.fn(async () => null),
      stopRun: vi.fn(async (_projectId: string, runId: string) => runId === "run-1" ? { runId, stopRequested: true as const } : null),
    },
    observations: {
      subject: vi.fn(async (projectId: string, samplingId: string) => ({
        role: "subject", projectId, samplingId, ownerUserId: owner, chatId: "chat-1", state: "available",
      })),
      evaluator: vi.fn(async (projectId: string, evaluationId: string) => ({
        role: "evaluator", projectId, samplingId: "s-1", evaluationId, ownerUserId: owner, state: "not-started",
      })),
    },
    metrics: {
      getProjectOverview: vi.fn(async () => ({ projectId: "project-1" })),
      getSampleOverview: vi.fn(async () => ({ projectSampleId: "sample-1" })),
    },
    materialBundles: {
      create: vi.fn(async () => ({ bundle: { bundleId: datasetId, name: "A", description: "B" }, imported: [] })),
      update: vi.fn(),
      import: vi.fn(),
    },
    agentConfigs: {
      list: vi.fn(async () => [{ id: "agent-1", user_id: owner, name: "Agent" }]),
      create: vi.fn(async () => { throw new EvalSpApiError(422, { code: "AGENT_CONFIG_INVALID", errMsg: "Name is required" }); }),
      update: vi.fn(async (id: string) => { throw new AgentConfigFrozenError(id); }),
      listAgents: vi.fn(async () => []),
    },
  };
  const sp = {
    verifySession: vi.fn(async (token: string) => token === "session" ? { id: owner, role: "user" as const } : null),
  };
  const release = vi.fn();
  const ownerServices = vi.fn(() => ({ services: services as unknown as OwnerServices, release }));
  const runtime: ApiRuntime = { webOrigin: WEB_ORIGIN, sp: sp as unknown as EvalSpClient, ownerServices };
  return { request: requestApp(runtime), services, sp, ownerServices, release };
}

describe("Eval API HTTP layer", () => {
  it("serves health without a session and wraps success in the SP envelope", async () => {
    const app = setup();
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, msg: { status: "ok" }, errMsg: "", code: "" });
  });

  it("requires a verified Eval SP session before composing owner services", async () => {
    const app = setup();
    const missing = await app.request("/api/projects");
    const invalid = await app.request("/api/projects", authorized("expired"));
    expect([missing.status, invalid.status]).toEqual([401, 401]);
    expect(await invalid.json()).toMatchObject({ code: "AUTH_UNAUTHENTICATED", requestId: invalid.headers.get("x-request-id") });
    expect(app.ownerServices).not.toHaveBeenCalled();
    app.sp.verifySession.mockRejectedValueOnce(new EvalSpTransportError(new Error("connect refused")));
    const unavailable = await app.request("/api/projects", authorized());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "EVAL_SP_UNAVAILABLE" });
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
    const created = await app.request("/api/projects", jsonRequest("POST", createBody));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ success: true, msg: { project: { name: "Tasks" }, run: { runId: "run-1" } } });
    expect(app.ownerServices).toHaveBeenCalledWith({ id: owner, role: "user" }, "session");
    app.services.results.getRun.mockRejectedValueOnce(new Error("database password is secret"));
    const failed = await app.request("/api/runs/run-1", authorized());
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain("secret");
    expect(app.release).toHaveBeenCalledTimes(2);
  });

  it("creates a Project from a validated snapshot request with canonical IDs", async () => {
    const app = setup();
    await app.request("/api/projects", jsonRequest("POST", {
      ...createBody, samplingCounts: { [datasetId.toUpperCase()]: 3 }, evaluation: evaluationPlan,
      run: { operation: "pipeline" },
    }));
    expect(app.services.projects.create).toHaveBeenCalledWith({
      ...createBody, name: "Tasks", datasets: [{ datasetId }], samplingCounts: { [datasetId]: 3 }, evaluation: evaluationPlan,
      run: { operation: "pipeline" },
    });
    const invalid = [
      { ...createBody, run: { operation: "evaluation" } },
      { ...createBody, run: { operation: "execution", idempotencyKey: "k" } },
      { ...createBody, idempotencyKey: " padded " },
      { ...createBody, idempotencyKey: undefined },
      { ...createBody, datasets: [{ datasetId }, { datasetId }] },
      { ...createBody, datasets: [] },
      { ...createBody, datasets: [{ datasetId, dataIds: [] }] },
      { ...createBody, samplingCount: SAMPLING_COUNT_MAX + 1 },
      { ...createBody, samplingCount: 0 },
      { ...createBody, ownerUserId: "other" },
      { ...createBody, execution: { ...createBody.execution, framework: "other" } },
    ];
    for (const body of invalid) {
      const response = await app.request("/api/projects", jsonRequest("POST", body));
      expect(response.status).toBe(422);
    }
    expect(app.services.projects.create).toHaveBeenCalledTimes(1);
  });

  it("returns the owned Project plan view and soft-deletes it", async () => {
    const app = setup();
    const response = await app.request("/api/projects/project-1", authorized());
    expect((await response.json() as { msg: unknown }).msg).toEqual(view);
    expect((await app.request("/api/projects/missing", authorized())).status).toBe(404);
    expect((await app.request("/api/projects/project-1", authorized("session", { method: "DELETE" }))).status).toBe(204);
    app.services.projects.delete.mockRejectedValueOnce(new RuntimeProjectBusyError("project-1", "run-1"));
    const busy = await app.request("/api/projects/project-1", authorized("session", { method: "DELETE" }));
    expect(await busy.json()).toMatchObject({ code: "PROJECT_BUSY" });
  });

  it("replaces only the evaluation plan and reports a locked plan", async () => {
    const app = setup();
    const replaced = await app.request("/api/projects/project-1/evaluation-plan", jsonRequest("PUT", evaluationPlan));
    expect(replaced.status).toBe(200);
    expect(app.services.projects.replaceEvaluationPlan).toHaveBeenCalledWith("project-1", evaluationPlan);
    app.services.projects.replaceEvaluationPlan.mockRejectedValueOnce(new ProjectEvaluationPlanLockedError("project-1"));
    const locked = await app.request("/api/projects/project-1/evaluation-plan", jsonRequest("PUT", evaluationPlan));
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ code: "PROJECT_EVALUATION_PLAN_LOCKED" });
    expect((await app.request("/api/projects/project-1/evaluation-plan",
      jsonRequest("PUT", { ...evaluationPlan, outputSchemaId: undefined }))).status).toBe(422);
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
    const oversized = await app.request(`/api/material-bundles/${datasetId}`, jsonRequest("PATCH", {
      name: "a".repeat(METADATA_BODY_BYTES), description: "b",
    }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "REQUEST_PAYLOAD_TOO_LARGE" });
    expect(app.services.datasets.createDataset).not.toHaveBeenCalled();
    expect(app.services.materialBundles.update).not.toHaveBeenCalled();
  });

  it("reads Bundle creation and ZIP import as bounded multipart bodies", async () => {
    const app = setup();
    const importPath = `/api/material-bundles/${datasetId}/import`;
    for (const path of ["/api/material-bundles", importPath]) {
      const json = await app.request(path, jsonRequest("POST", { name: "A", description: "B" }));
      expect(json.status).toBe(415);
      expect(await json.json()).toMatchObject({ code: "REQUEST_UNSUPPORTED_MEDIA_TYPE" });
    }
    const oversized = await app.request("/api/material-bundles", authorized("session", {
      method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body: new Uint8Array(ZIP_BODY_BYTES + 1),
    }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "REQUEST_PAYLOAD_TOO_LARGE" });
    const malformed = await app.request(importPath, authorized("session", {
      method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body: "not multipart",
    }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "REQUEST_INVALID_INPUT" });
    const missingZip = await app.request(importPath, authorized("session", { method: "POST", body: new FormData() }));
    expect(missingZip.status).toBe(422);
    expect(await missingZip.json()).toMatchObject({ code: "REQUEST_VALIDATION_FAILED", errors: [expect.objectContaining({ path: "zip" })] });
    expect(app.services.materialBundles.import).not.toHaveBeenCalled();
    const fields = new FormData();
    fields.append("name", " A ");
    fields.append("description", "B");
    const created = await app.request("/api/material-bundles", authorized("session", { method: "POST", body: fields }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ msg: { bundle: { bundleId: datasetId }, imported: [] } });
    expect(app.services.materialBundles.create).toHaveBeenCalledWith({ name: "A", description: "B" }, []);
  });

  it("routes each Bundle kind only to its own resource kind", async () => {
    const app = setup();
    for (const path of [`/api/material-bundles/${datasetId}/sessions`, `/api/session-bundles/${datasetId}/materials`]) {
      const response = await app.request(path, authorized());
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "REQUEST_NOT_FOUND" });
    }
  });

  it("validates path, query and body with the route schemas", async () => {
    const app = setup();
    expect((await app.request("/api/datasets/not-a-uuid/data", authorized())).status).toBe(422);
    expect((await app.request("/api/metrics/projects/project-1?extra=1", authorized())).status).toBe(422);
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

  it("previews a selection and submits its fixed targets unchanged", async () => {
    const app = setup();
    const selector = { datasetIds: [datasetId], samplingIds: ["s-9"] };
    const previewed = await app.request("/api/projects/project-1/runs/preview", jsonRequest("POST", { operation: "pipeline", selector }));
    expect(previewed.status).toBe(200);
    expect(await previewed.json()).toMatchObject({ msg: preview });
    expect(app.services.admission.preview).toHaveBeenCalledWith({ projectId: "project-1", operation: "pipeline", selector });
    const body = { idempotencyKey: "click-1", operation: "execution", selector: { all: true }, targets: preview.targets };
    const submitted = await app.request("/api/projects/project-1/runs", jsonRequest("POST", body));
    expect(submitted.status).toBe(202);
    expect(app.services.admission.submit).toHaveBeenCalledWith({ projectId: "project-1", ...body });

    for (const invalid of [
      { ...body, selector: {} },
      { ...body, selector: { all: false } },
      { ...body, targets: { projectSampleIds: ["a", "a"], samplingIds: [] } },
      { ...body, targets: { projectSampleIds: [] } },
      { ...body, targets: { projectSampleIds: Array.from({ length: RUN_TARGET_IDS }, (_, i) => `p-${i}`), samplingIds: ["s"] } },
    ]) {
      expect((await app.request("/api/projects/project-1/runs", jsonRequest("POST", invalid))).status).toBe(422);
    }
    expect(app.services.admission.submit).toHaveBeenCalledTimes(1);
  });

  it("refuses an expanded selection beyond one request and maps admission conflicts", async () => {
    const app = setup();
    app.services.admission.preview.mockResolvedValueOnce({
      ...preview, targets: { projectSampleIds: [], samplingIds: Array.from({ length: RUN_TARGET_IDS + 1 }, (_, i) => `s-${i}`) },
    });
    const tooLarge = await app.request("/api/projects/project-1/runs/preview", jsonRequest("POST", { operation: "evaluation", selector: { all: true } }));
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ code: "RUN_TARGETS_TOO_LARGE" });
    const body = { idempotencyKey: "k", operation: "evaluation", selector: { all: true }, targets: preview.targets };
    for (const [error, code] of [
      [new RuntimeAdmissionConflictError("evaluation-plan-required", "m"), "PROJECT_EVALUATION_PLAN_REQUIRED"],
      [new RuntimeAdmissionConflictError("stale-targets", "m"), "RUN_TARGETS_STALE"],
      [new RuntimeAdmissionConflictError("plan-changed", "m"), "PROJECT_PLAN_CHANGED"],
      [new RuntimeProjectBusyError("project-1", "active-run"), "PROJECT_BUSY"],
    ] as const) {
      app.services.admission.submit.mockRejectedValueOnce(error);
      const response = await app.request("/api/projects/project-1/runs", jsonRequest("POST", body));
      expect([response.status, (await response.json() as { code: string }).code]).toEqual([409, code]);
    }
  });

  it("serves the current Run and targeted stop", async () => {
    const app = setup();
    expect(await (await app.request("/api/projects/project-1/runs/current", authorized())).json())
      .toMatchObject({ msg: { run: null } });
    expect((await app.request("/api/projects/missing/runs/current", authorized())).status).toBe(404);
    const stopped = await app.request("/api/projects/project-1/runs/run-1/stop", authorized("session", { method: "POST" }));
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toMatchObject({ msg: { runId: "run-1", stopRequested: true } });
    const unknown = await app.request("/api/projects/project-1/runs/old/stop", authorized("session", { method: "POST" }));
    expect(await unknown.json()).toMatchObject({ code: "RUN_NOT_FOUND" });
  });

  it("resolves read-only Chat observation targets", async () => {
    const app = setup();
    const subject = await app.request("/api/projects/project-1/samplings/s-1/observation", authorized());
    expect(await subject.json()).toMatchObject({ msg: { role: "subject", chatId: "chat-1", state: "available" } });
    const evaluator = await app.request("/api/projects/project-1/evaluations/e-1/observation", authorized());
    expect(await evaluator.json()).toMatchObject({ msg: { role: "evaluator", evaluationId: "e-1", state: "not-started" } });
    expect(app.services.observations.evaluator).toHaveBeenCalledWith("project-1", "e-1");
  });

  it("passes repeated Run filters and ProjectSample IDs to Metrics", async () => {
    const app = setup();
    await app.request("/api/metrics/projects/project-1?runId=run-1&runId=run-2", authorized());
    await app.request("/api/metrics/projects/project-1", authorized());
    await app.request("/api/metrics/projects/project-1/samples/sample-1?runId=run-1", authorized());
    expect(app.services.metrics.getProjectOverview.mock.calls).toEqual([
      [{ projectId: "project-1", runIds: ["run-1", "run-2"] }],
      [{ projectId: "project-1" }],
    ]);
    expect(app.services.metrics.getSampleOverview).toHaveBeenCalledWith({ projectId: "project-1", runIds: ["run-1"], projectSampleId: "sample-1" });
  });

  it("proxies Agent Configs, rejects frozen copy writes and relays SP validation text", async () => {
    const app = setup();
    const listed = await app.request("/api/agent-configs", authorized());
    expect(await listed.json()).toMatchObject({ msg: [{ id: "agent-1" }] });
    const rejected = await app.request("/api/agent-configs", jsonRequest("POST", { name: "" }));
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ code: "EVAL_SP_REQUEST_INVALID", errMsg: "Name is required" });
    const frozen = await app.request(`/api/agent-configs/${agentId}`, jsonRequest("PATCH", { name: "x", revision: 1 }));
    expect(frozen.status).toBe(409);
    expect(await frozen.json()).toMatchObject({ code: "AGENT_CONFIG_FROZEN" });
    for (const [method, path] of [["POST", "/api/agent-configs"], ["PATCH", `/api/agent-configs/${agentId}`]] as const) {
      const reserved = await app.request(path, jsonRequest(method, { slug: " Eval-Frozen-mine ", name: "Mine" }));
      expect(reserved.status).toBe(422);
      expect(await reserved.json()).toMatchObject({ code: "REQUEST_VALIDATION_FAILED", errors: [expect.objectContaining({ path: "slug" })] });
    }
    expect(app.services.agentConfigs.create).toHaveBeenCalledTimes(1);
  });

  it("leaves plan semantics to the service: pipeline without evaluation and plan values return 400", async () => {
    const app = setup();
    app.services.projects.create.mockRejectedValueOnce(new RuntimeInputError("A pipeline Run requires an evaluation plan", "evaluation"));
    const pipeline = await app.request("/api/projects", jsonRequest("POST", { ...createBody, run: { operation: "pipeline" } }));
    expect(pipeline.status).toBe(400);
    expect(await pipeline.json()).toMatchObject({ code: "RUNTIME_INPUT_INVALID", errors: [{ path: "evaluation" }] });
    const values = await app.request("/api/projects", jsonRequest("POST", {
      ...createBody, execution: { ...createBody.execution, executionConcurrency: 1.5, timeoutMs: 0, retryPolicy: { maxRestarts: -1, initialBackoffMs: 5, maxBackoffMs: 1 } },
    }));
    expect(values.status).toBe(201);
    expect(app.services.projects.create).toHaveBeenCalledTimes(2);
  });
});
