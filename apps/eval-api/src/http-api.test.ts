import { describe, expect, it, vi } from "vitest";
import { parseDatasetDocument } from "@eval-platform/eval-dataset";
import { RuntimeProjectBusyError } from "@eval-platform/eval-runtime";
import type { EvalDb } from "./db/client.js";
import type { EvalSpClient } from "./sp/client.js";
import { EvalSpTransportError } from "./sp/client.js";
import { createEvalApiHandler, type EvalApiOwnerServices } from "./http-api.js";
import { createIndependentEvaluationApi } from "./independent-evaluation-api.js";
import { createInitialResourceHttpHandler } from "./initial-resources.http.js";
import type { BundleDirectory } from "./sp/bundle-directory.js";

const owner = "11111111-1111-4111-8111-111111111111";
const datasetId = "00000000-0000-4000-8000-000000000001";

function request(path: string, method = "GET", body?: unknown, token = "session"): Request {
  return new Request(`http://eval.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function setup() {
  const verifySession = vi.fn(async (token: string) => token === "session" ? { id: owner, role: "user" as const } : null);
  const sp = {
    verifySession,
    listAgentConfigs: vi.fn(async () => [{ id: "agent-1", user_id: owner, name: "Agent" }]),
  } as unknown as EvalSpClient;
  const createProject = vi.fn(async ({ name }: { name: string }) => ({ projectId: "project-1", ownerUserId: owner, name }));
  const createDataset = vi.fn(async ({ name }: { name: string }) => ({ datasetId, name }));
  const importDataset = vi.fn(async () => ({ dataset: { datasetId: "dataset-1", name: "Cases" }, data: [] }));
  const exportDataset = vi.fn(async () => "dataset:\n  name: Cases\ndata: []\n");
  const getData = vi.fn(async () => null);
  const createExecutionConfig = vi.fn(async () => ({ configId: "config-1", datasetId }));
  const start = vi.fn(async () => ({ runId: "run-1", samplingIds: ["sampling-1"] }));
  const evaluate = vi.fn(async () => ({ runId: "run-2", samplingIds: ["sampling-1"] }));
  const getRun = vi.fn(async () => ({ runId: "run-1", samplingIds: ["sampling-1"], status: "queued" }));
  const getProjectOverview = vi.fn(async () => ({ project: { projectId: "project-1" }, counts: { samplings: 1 } }));
  const forOwner = vi.fn((_owner: string, _token: string) => ({
    catalog: { createProject, getProject: async () => ({ projectId: "project-1", ownerUserId: owner, name: "Tasks" }),
      listProjects: async () => [], listAgents: async () => [],
      selectAllSuccessfulSamplingIds: async () => ["sampling-1"] },
    datasets: { createDataset, importDataset, exportDataset, getData, listDatasets: async () => [] },
    configs: { createExecutionConfig },
    runtime: { start, evaluate, getRun },
    metrics: { getProjectOverview },
  }) as unknown as EvalApiOwnerServices);
  const initialResources = vi.fn(async (input: Request, selectedOwner: string) =>
    new URL(input.url).pathname.startsWith("/api/bundles/")
      ? Response.json({ ownerUserId: selectedOwner }) : null);
  const independentEvaluation = createIndependentEvaluationApi({
    spClient: sp,
    createOwnerServices: () => ({
      catalog: {
        getProject: async () => ({ projectId: "project-1", ownerUserId: owner, name: "Tasks", sourceBranch: "eval" }),
        listSuccessfulSamplings: async () => ({ samplings: [{ samplingId: "sampling-1", sampleId: "sample-1" }], nextCursor: null }),
        selectAllSuccessfulSamplingIds: async () => ["sampling-1"],
      },
      runtime: { evaluate },
      readRun: async () => null,
    }),
  });
  const handler = createEvalApiHandler({ sp, forOwner, initialResources, independentEvaluation });
  return { handler, sp, verifySession, forOwner, initialResources, createProject, createDataset, importDataset,
    exportDataset, getData, createExecutionConfig, start, evaluate, getRun, getProjectOverview };
}

describe("Eval HTTP control plane", () => {
  it("authenticates before accessing owner-scoped services or resource uploads", async () => {
    const app = setup();
    const missing = await app.handler(new Request("http://eval.test/api/projects"));
    const invalid = await app.handler(request("/api/bundles/a/materials/b", "PUT", { files: [] }, "bad"));
    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(app.forOwner).not.toHaveBeenCalled();
    expect(app.initialResources).not.toHaveBeenCalled();
    const upload = await app.handler(request("/api/bundles/a/materials/b", "PUT", { files: [] }));
    expect(upload.status).toBe(200);
    expect(await upload.json()).toEqual({ ownerUserId: owner });
    expect(app.initialResources).toHaveBeenCalledWith(expect.any(Request), owner);
  });

  it("mounts the real Bundle upload handler after authentication", async () => {
    const app = setup();
    const uploadInitialMaterials = vi.fn(async () => undefined);
    const bundles = { uploadInitialMaterials } as unknown as BundleDirectory;
    const handler = createEvalApiHandler({
      sp: app.sp,
      forOwner: app.forOwner,
      initialResources: createInitialResourceHttpHandler({} as EvalDb, bundles),
    });
    const files = [{ path: "/brief.txt", mediaType: "text/plain", contentBase64: "SGk=" }];
    const response = await handler(request("/api/bundles/project%2Fassets/materials/brief", "PUT", { files }));
    expect(response.status).toBe(200);
    expect(uploadInitialMaterials).toHaveBeenCalledWith(owner,
      { bundleId: "project/assets", materialId: "brief" }, files);
    const duplicate = await handler(new Request("http://eval.test/api/bundles/a/materials/b", {
      method: "PUT", headers: { Authorization: "Bearer session", "Content-Type": "application/json" },
      body: '{"files":[],"files":[]}',
    }));
    expect(duplicate.status).toBe(400);
    expect(uploadInitialMaterials).toHaveBeenCalledTimes(1);
    const invalidUtf8 = await handler(new Request("http://eval.test/api/bundles/a/materials/b", {
      method: "PUT", headers: { Authorization: "Bearer session", "Content-Type": "application/json" },
      body: new Uint8Array([0xff]),
    }));
    expect(invalidUtf8.status).toBe(400);
    expect(uploadInitialMaterials).toHaveBeenCalledTimes(1);
  });

  it("routes project, Dataset, Config, Run and Metrics operations under the verified owner", async () => {
    const app = setup();
    const project = await app.handler(request("/api/projects", "POST", { name: "Tasks" }));
    const dataset = await app.handler(request("/api/datasets", "POST", { name: "Cases" }));
    const config = await app.handler(request("/api/configs/execution", "POST", {
      datasetId, harness: { kind: "sp" }, samplingCount: 1, executionConcurrency: 1,
    }));
    const run = await app.handler(request("/api/runs/execution", "POST", {
      idempotencyKey: "launch-1", projectId: "project-1", executionConfigId: "config-1",
    }));
    const snapshot = await app.handler(request("/api/runs/run-1"));
    const metrics = await app.handler(request("/api/metrics/projects/project-1?runId=run-1"));
    expect([project.status, dataset.status, config.status, run.status, snapshot.status, metrics.status])
      .toEqual([201, 201, 201, 201, 200, 200]);
    expect(await run.json()).toEqual({ runId: "run-1", samplingIds: ["sampling-1"] });
    expect(app.forOwner).toHaveBeenCalledWith(owner, "session");
    expect(app.start).toHaveBeenCalledWith({
      idempotencyKey: "launch-1", projectId: "project-1", executionConfigId: "config-1",
    });
    expect(app.getProjectOverview).toHaveBeenCalledWith({ projectId: "project-1", runIds: ["run-1"] });
  });

  it("rejects client ownership fields and maps missing or unexpected failures", async () => {
    const app = setup();
    const spoofed = await app.handler(request("/api/projects", "POST", { name: "Tasks", ownerUserId: "other" }));
    expect(spoofed.status).toBe(400);
    expect(app.createProject).not.toHaveBeenCalled();
    const missing = await app.handler(request("/api/data/data-1"));
    expect(missing.status).toBe(404);
    app.verifySession.mockRejectedValueOnce(new EvalSpTransportError(new Error("connect failed")));
    expect((await app.handler(request("/api/projects"))).status).toBe(502);
    app.getRun.mockRejectedValueOnce(new Error("Unknown run run-404"));
    expect((await app.handler(request("/api/runs/run-404"))).status).toBe(404);
    app.start.mockRejectedValueOnce(new Error("Unknown Project project-404"));
    expect((await app.handler(request("/api/runs/execution", "POST", {
      idempotencyKey: "launch-1", projectId: "project-404", executionConfigId: "config-1",
    }))).status).toBe(404);
    app.createExecutionConfig.mockRejectedValueOnce(new Error("samplingCount must be a positive integer"));
    expect((await app.handler(request("/api/configs/execution", "POST", {
      datasetId, harness: { kind: "sp" }, samplingCount: 0, executionConcurrency: 1,
    }))).status).toBe(400);
    app.getRun.mockRejectedValueOnce(new Error("database password is secret"));
    const internal = await app.handler(request("/api/runs/run-1"));
    expect(internal.status).toBe(500);
    expect(JSON.stringify(await internal.json())).not.toContain("secret");
    app.getRun.mockRejectedValueOnce(new Error("database must expose secret"));
    const unknown = await app.handler(request("/api/runs/run-1"));
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(await unknown.json())).not.toContain("secret");
  });

  it("reports an active Project as a conflict on Run admission", async () => {
    const app = setup();
    app.start.mockRejectedValueOnce(new RuntimeProjectBusyError("project-1", "active-run"));
    const response = await app.handler(request("/api/runs/execution", "POST", {
      idempotencyKey: "new-run", projectId: "project-1", executionConfigId: "config-1",
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: {
      code: "project_busy", message: "Project project-1 already has unfinished Run active-run",
    } });
  });

  it("imports raw Dataset documents and mounts the established independent evaluation routes", async () => {
    const app = setup();
    const imported = await app.handler(new Request("http://eval.test/api/datasets/import?format=yaml", {
      method: "POST", headers: { Authorization: "Bearer session" }, body: "dataset: { name: Cases }\ndata: []\n",
    }));
    const exported = await app.handler(request("/api/datasets/dataset-1/export?format=yaml"));
    const selected = await app.handler(request("/api/projects/project-1/samplings/successful/ids"));
    const evaluation = await app.handler(request("/api/projects/project-1/evaluations", "POST", {
      idempotencyKey: "evaluate-1", evaluationConfigId: "judge-1",
      samplingIds: ["sampling-1"],
    }));
    expect([imported.status, exported.status, selected.status, evaluation.status]).toEqual([201, 200, 200, 202]);
    expect(app.importDataset).toHaveBeenCalledWith("dataset: { name: Cases }\ndata: []\n", "yaml");
    expect(app.exportDataset).toHaveBeenCalledWith("dataset-1", "yaml");
    expect(await selected.json()).toEqual({ samplingIds: ["sampling-1"] });
    expect(app.evaluate).toHaveBeenCalledWith({
      idempotencyKey: "evaluate-1", projectId: "project-1", evaluationConfigId: "judge-1",
      samplingIds: ["sampling-1"],
    });
    expect(app.forOwner).toHaveBeenCalledTimes(2);
    const oldEvaluation = await app.handler(request("/api/runs/evaluation", "POST", {
      idempotencyKey: "evaluate-1", projectId: "project-1", evaluationConfigId: "judge-1", samplingIds: ["sampling-1"],
    }));
    expect(oldEvaluation.status).toBe(404);
    const unsupported = await app.handler(new Request("http://eval.test/api/projects/project-1/evaluations", {
      method: "POST", headers: { Authorization: "Bearer session", "Content-Type": "text/plain" }, body: "{}",
    }));
    expect(unsupported.status).toBe(415);
  });

  it("dispatches all five project-scoped evaluation paths to the established handler", async () => {
    const app = setup();
    const handle = vi.fn(async () => Response.json({ mounted: true }));
    const handler = createEvalApiHandler({
      sp: app.sp, forOwner: app.forOwner, initialResources: app.initialResources,
      independentEvaluation: { handle },
    });
    const paths = [
      "/api/projects/project-1/samplings/successful",
      "/api/projects/project-1/samplings/successful/ids",
      "/api/projects/project-1/evaluations",
      "/api/projects/project-1/runs/run-1",
      "/api/projects/project-1/runs/run-1/evaluations",
    ];
    for (const path of paths) expect((await handler(request(path))).status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(paths.length);
    expect(app.forOwner).not.toHaveBeenCalled();
  });

  it("rejects duplicate JSON fields before creating Dataset or Data", async () => {
    const app = setup();
    const duplicate = new Request("http://eval.test/api/datasets", {
      method: "POST",
      headers: { Authorization: "Bearer session", "Content-Type": "application/json" },
      body: '{"name":"first","nested":{"id":1,"id":2}}',
    });
    expect((await app.handler(duplicate)).status).toBe(400);
    expect(app.createDataset).not.toHaveBeenCalled();
    const invalidUtf8 = await app.handler(new Request("http://eval.test/api/datasets/import?format=json", {
      method: "POST", headers: { Authorization: "Bearer session" }, body: new Uint8Array([0xff]),
    }));
    expect(invalidUtf8.status).toBe(400);
    expect(app.importDataset).not.toHaveBeenCalled();
  });

  it("returns specific client statuses while hiding unexpected TypeErrors", async () => {
    const app = setup();
    // Dataset parsing can report YAMLParseError or YAMLWarning.
    app.importDataset.mockRejectedValueOnce(Object.assign(new Error("private document contents"), { name: "YAMLParseError" }));
    const parserFailure = await app.handler(new Request("http://eval.test/api/datasets/import?format=yaml", {
      method: "POST", headers: { Authorization: "Bearer session" }, body: "dataset: [\n",
    }));
    expect(parserFailure.status).toBe(400);
    let warning: unknown;
    try { parseDatasetDocument("dataset: !unknown { name: Cases }\ndata: []\n", "yaml"); }
    catch (error) { warning = error; }
    expect(warning).toBeInstanceOf(Error);
    expect((warning as Error).name).toBe("YAMLWarning");
    app.importDataset.mockRejectedValueOnce(warning);
    const warningResponse = await app.handler(new Request("http://eval.test/api/datasets/import?format=yaml", {
      method: "POST", headers: { Authorization: "Bearer session" }, body: "dataset: !unknown { name: Cases }\ndata: []\n",
    }));
    expect(warningResponse.status).toBe(400);
    app.getRun.mockRejectedValueOnce(new TypeError("database must expose secret"));
    const internal = await app.handler(request("/api/runs/run-1"));
    expect(internal.status).toBe(500);
    expect(JSON.stringify(await internal.json())).not.toContain("secret");
  });

  it("rejects malformed UUID inputs before querying PostgreSQL UUID columns", async () => {
    const app = setup();
    expect((await app.handler(request("/api/samples?dataId=not-a-uuid"))).status).toBe(400);
    expect((await app.handler(request("/api/samples", "POST", { dataId: "not-a-uuid" }))).status).toBe(400);
    expect((await app.handler(request("/api/data?datasetId=not-a-uuid"))).status).toBe(400);
    expect((await app.handler(request("/api/datasets/not-a-uuid/data"))).status).toBe(400);
    expect((await app.handler(request("/api/configs/execution", "POST", {
      datasetId: "not-a-uuid", harness: { kind: "sp" }, samplingCount: 1, executionConcurrency: 1,
    }))).status).toBe(400);
    expect((await app.handler(request("/api/metrics/projects/project-1/datasets/not-a-uuid"))).status).toBe(400);
    expect(app.createExecutionConfig).not.toHaveBeenCalled();
  });

  it("maps an oversized resource upload to 413 and releases acquired owner services", async () => {
    const app = setup();
    const tooLarge = createEvalApiHandler({
      sp: app.sp, forOwner: app.forOwner,
      initialResources: async () => { throw new RangeError("Request body is too large"); },
    });
    expect((await tooLarge(request("/api/bundles/a/materials/b", "PUT", { files: [] }))).status).toBe(413);
    const release = vi.fn();
    const services = app.forOwner(owner, "session");
    const handler = createEvalApiHandler({
      sp: app.sp, initialResources: app.initialResources,
      forOwner: () => ({ ...services, release }),
    });
    expect((await handler(request("/api/me"))).status).toBe(200);
    app.getRun.mockRejectedValueOnce(new Error("database unavailable"));
    expect((await handler(request("/api/runs/run-1"))).status).toBe(500);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
