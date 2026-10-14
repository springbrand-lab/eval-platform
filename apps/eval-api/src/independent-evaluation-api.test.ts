import { ConfigNotFoundError, RuntimeEvaluationSelectionError, RuntimeProjectBusyError, RuntimeRunIdentityConflictError } from "@eval-platform/eval-runtime";
import { describe, expect, it, vi } from "vitest";
import { createIndependentEvaluationApi } from "./independent-evaluation-api.js";
import { createIndependentEvaluationHttpServer } from "./independent-evaluation-http.js";
import { ProjectRunStopConflictError } from "./db/runtime.js";

const project = { projectId: "project-1", ownerUserId: "alice", name: "Evaluation", sourceBranch: "release-2.0.0" };
const samplingIds = ["sampling-1", "sampling-2"];
const run = {
  runId: "run-1", projectId: project.projectId, sourceCommit: "a".repeat(40), samplingIds,
  evaluationIds: ["evaluation-1", "evaluation-2"],
  phases: ["evaluation"] as const, phase: "evaluation" as const, status: "queued" as const,
};
const evaluation = (evaluationId: string, samplingId: string) => ({
  evaluationId, samplingId,
  evaluator: { ownerUserId: "alice", userAgentId: "judge" },
  status: { status: "queued" as const }, attempts: [],
});

function fixture() {
  const spClient = {
    verifySession: vi.fn(async (token: string) => token === "alice-token"
      ? { id: "alice", role: "user" as const }
      : token === "bob-token" ? { id: "bob", role: "user" as const } : null),
  };
  const catalog = {
    getProject: vi.fn(async (projectId: string) => projectId === project.projectId ? project : null),
    listSuccessfulSamplings: vi.fn(async () => ({
      samplings: [{ samplingId: samplingIds[0]!, sampleId: "sample-1" }], nextCursor: samplingIds[0]!,
    })),
    selectAllSuccessfulSamplingIds: vi.fn(async () => samplingIds),
  };
  const runtime = {
    evaluate: vi.fn(async () => ({ runId: run.runId, samplingIds })),
  };
  const readRun = vi.fn(async (ownerUserId: string, projectId: string, runId: string) => (
    ownerUserId === "alice" && projectId === "project-1" && runId === "run-1"
      ? { run, evaluations: [
        evaluation("evaluation-1", samplingIds[0]!), evaluation("evaluation-2", samplingIds[1]!),
      ] }
      : null
  ));
  const getCurrentRun = vi.fn(async () => ({ runId: run.runId }));
  const stopRun = vi.fn(async (): Promise<{ runId: string; stopRequested: true } | null> =>
    ({ runId: run.runId, stopRequested: true }));
  const createOwnerServices = vi.fn(async (ownerUserId: string) => ({
    catalog: ownerUserId === "alice" ? catalog : {
      ...catalog,
      getProject: vi.fn(async () => null),
    },
    runtime,
    readRun: (projectId: string, runId: string) => readRun(ownerUserId, projectId, runId),
    getCurrentRun,
    stopRun,
  }));
  const api = createIndependentEvaluationApi({ spClient, createOwnerServices });
  return { api, spClient, catalog, runtime, readRun, getCurrentRun, stopRun, createOwnerServices };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://eval-api.test${path}`, {
    ...init,
    headers: { Authorization: "Bearer alice-token", ...init.headers },
  });
}

async function body(response: Response): Promise<unknown> {
  return response.json();
}

describe("independent evaluation HTTP API", () => {
  it("requests stopping a named current Run without retargeting a later Run", async () => {
    const { api, getCurrentRun, stopRun } = fixture();
    const path = "/api/projects/project-1/runs/run-1/stop";
    expect(await body(await api.handle(request("/api/projects/project-1/runs/current"))))
      .toEqual({ run: { runId: "run-1" } });
    expect(getCurrentRun).toHaveBeenCalledWith("project-1");
    const stopped = await api.handle(request(path, { method: "POST" }));
    expect(stopped.status).toBe(202);
    expect(await body(stopped)).toEqual({ runId: "run-1", stopRequested: true });
    expect(stopRun).toHaveBeenCalledWith("project-1", "run-1");
    stopRun.mockResolvedValueOnce(null);
    expect((await api.handle(request(path, { method: "POST" }))).status).toBe(404);
    stopRun.mockRejectedValueOnce(new ProjectRunStopConflictError());
    expect(await body(await api.handle(request(path, { method: "POST" }))))
      .toEqual({ error: { code: "NO_ACTIVE_RUN", message: "Project has no unfinished Run" } });
    expect((await api.handle(request(path, { method: "GET" }))).status).toBe(405);
    expect((await api.handle(request("/api/projects/other/runs/run-1/stop", { method: "POST" }))).status).toBe(404);
  });
  it("verifies every request with Eval SP and forwards the same Project filter to page and all-ID queries", async () => {
    const { api, spClient, catalog, createOwnerServices } = fixture();
    const [page, allIds] = await Promise.all([
      api.handle(request("/api/projects/project-1/samplings/successful?sampleId=sample-1&afterSamplingId=previous&limit=1")),
      api.handle(request("/api/projects/project-1/samplings/successful/ids?sampleId=sample-1")),
    ]);
    expect(page.status).toBe(200);
    expect(await body(page)).toEqual({ samplings: [{ samplingId: "sampling-1", sampleId: "sample-1" }], nextCursor: "sampling-1" });
    expect(allIds.status).toBe(200);
    expect(await body(allIds)).toEqual({ samplingIds });
    expect(catalog.listSuccessfulSamplings).toHaveBeenCalledWith("project-1", {
      sampleId: "sample-1", afterSamplingId: "previous", limit: 1,
    });
    expect(catalog.selectAllSuccessfulSamplingIds).toHaveBeenCalledWith("project-1", { sampleId: "sample-1" });
    expect(spClient.verifySession).toHaveBeenCalledTimes(2);
    expect(createOwnerServices).toHaveBeenCalledTimes(1);
    expect(createOwnerServices).toHaveBeenCalledWith("alice");
    await api.handle(request("/api/projects/project-1/samplings/successful/ids"));
    expect(createOwnerServices).toHaveBeenCalledTimes(2);
  });

  it("rejects absent or invalid sessions and inaccessible Projects before querying Samplings", async () => {
    const { api, spClient, catalog } = fixture();
    const noToken = await api.handle(new Request("http://eval-api.test/api/projects/project-1/samplings/successful"));
    const invalid = await api.handle(request("/api/projects/project-1/samplings/successful", { headers: { Authorization: "Bearer invalid" } }));
    const bob = await api.handle(request("/api/projects/project-1/samplings/successful", { headers: { Authorization: "Bearer bob-token" } }));
    expect(noToken.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(bob.status).toBe(404);
    expect(spClient.verifySession).toHaveBeenCalledTimes(2);
    expect(catalog.listSuccessfulSamplings).not.toHaveBeenCalled();
  });

  it("submits only the caller's fixed ordered IDs and preserves the key on repeated requests", async () => {
    const { api, runtime, catalog } = fixture();
    const payload = JSON.stringify({ evaluationConfigId: "config-1", samplingIds, idempotencyKey: "click-1" });
    const submit = () => api.handle(request("/api/projects/project-1/evaluations", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
    }));
    const [first, repeat] = await Promise.all([submit(), submit()]);
    expect(first.status).toBe(202);
    expect(repeat.status).toBe(202);
    expect(await body(first)).toEqual({ runId: "run-1", samplingIds });
    expect(await body(repeat)).toEqual({ runId: "run-1", samplingIds });
    expect(runtime.evaluate).toHaveBeenCalledTimes(2);
    expect(runtime.evaluate).toHaveBeenCalledWith({
      projectId: "project-1", evaluationConfigId: "config-1", samplingIds, idempotencyKey: "click-1",
    });
    expect(catalog.selectAllSuccessfulSamplingIds).not.toHaveBeenCalled();
  });

  it("returns the Run and its EvaluationRecords only within the requested Project", async () => {
    const { api, catalog, readRun } = fixture();
    const snapshot = await api.handle(request("/api/projects/project-1/runs/run-1"));
    const results = await api.handle(request("/api/projects/project-1/runs/run-1/evaluations"));
    expect(snapshot.status).toBe(200);
    expect(await body(snapshot)).toEqual({ run });
    expect(results.status).toBe(200);
    expect(await body(results)).toEqual({ evaluations: [
      evaluation("evaluation-1", "sampling-1"), evaluation("evaluation-2", "sampling-2"),
    ] });
    expect(readRun).toHaveBeenCalledTimes(2);
    expect(readRun).toHaveBeenCalledWith("alice", "project-1", "run-1");
    expect((await api.handle(request("/api/projects/project-2/runs/run-1/evaluations"))).status).toBe(404);
    expect((await api.handle(request("/api/projects/project-1/runs/run-1", {
      headers: { Authorization: "Bearer bob-token" },
    }))).status).toBe(404);
    expect((await api.handle(request("/api/projects/project-1/runs/missing"))).status).toBe(404);
    readRun.mockResolvedValueOnce({ run: { ...run, projectId: "project-2" }, evaluations: [] });
    expect((await api.handle(request("/api/projects/project-1/runs/run-1"))).status).toBe(404);
    expect(catalog.getProject).not.toHaveBeenCalled();
  });

  it("distinguishes invalid input, changed selections, key conflicts and SP outages", async () => {
    const { api, runtime, spClient } = fixture();
    const post = (payload: unknown, contentType = "application/json") => api.handle(request("/api/projects/project-1/evaluations", {
      method: "POST", headers: { "Content-Type": contentType }, body: JSON.stringify(payload),
    }));
    expect((await post({ evaluationConfigId: "config-1", samplingIds: [], idempotencyKey: "click" })).status).toBe(400);
    expect((await post({ evaluationConfigId: "config-1", samplingIds: ["a", "a"], idempotencyKey: "click" })).status).toBe(400);
    expect((await post({ evaluationConfigId: "config-1", samplingIds, idempotencyKey: "click", projectId: "other" })).status).toBe(400);
    expect((await post({ evaluationConfigId: "config-1", samplingIds, idempotencyKey: "click" }, "text/plain")).status).toBe(415);
    expect((await api.handle(request("/api/projects/project-1/evaluations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: '{"evaluationConfigId":"first","evaluationConfigId":"config-1","samplingIds":["sampling-1"],"idempotencyKey":"click"}',
    }))).status).toBe(400);
    expect((await api.handle(request("/api/projects/project-1/samplings/successful?limit=0"))).status).toBe(400);
    expect((await api.handle(request("/api/projects/project-1/samplings/successful?sampleId=a&sampleId=b"))).status).toBe(400);
    expect(runtime.evaluate).not.toHaveBeenCalled();

    runtime.evaluate.mockRejectedValueOnce(new RuntimeEvaluationSelectionError("selection changed"));
    const selected = await post({ evaluationConfigId: "config-1", samplingIds, idempotencyKey: "click" });
    expect(selected.status).toBe(409);
    expect(await body(selected)).toEqual({ error: {
      code: "SAMPLING_UNAVAILABLE", message: "Selected Sampling is unavailable for evaluation",
    } });
    runtime.evaluate.mockRejectedValueOnce(new RuntimeRunIdentityConflictError("different request facts"));
    const conflict = await post({ evaluationConfigId: "config-1", samplingIds, idempotencyKey: "click" });
    expect(conflict.status).toBe(409);
    expect(await body(conflict)).toEqual({ error: {
      code: "IDEMPOTENCY_CONFLICT", message: "different request facts",
    } });
    runtime.evaluate.mockRejectedValueOnce(new RuntimeProjectBusyError("project-1", "active-run"));
    const busy = await post({ evaluationConfigId: "config-1", samplingIds, idempotencyKey: "new-click" });
    expect(busy.status).toBe(409);
    expect(await body(busy)).toEqual({ error: {
      code: "PROJECT_BUSY", message: "Project project-1 already has unfinished Run active-run",
    } });
    runtime.evaluate.mockRejectedValueOnce(new ConfigNotFoundError("evaluation", "config-1"));
    expect((await post({ evaluationConfigId: "config-1", samplingIds, idempotencyKey: "new-click" })).status).toBe(404);
    spClient.verifySession.mockRejectedValueOnce(new Error("SP down"));
    const outage = await api.handle(request("/api/projects/project-1/samplings/successful"));
    expect(outage.status).toBe(502);
    expect(await body(outage)).toEqual({ error: {
      code: "SP_UNAVAILABLE", message: "Eval SP session verification failed",
    } });
  });

  it("accepts a fixed all-selection list larger than 4 MiB", async () => {
    const { api, runtime } = fixture();
    const selectedIds = Array.from({ length: 9_000 }, (_, index) => `${index}-${"x".repeat(495)}`);
    const payload = JSON.stringify({
      evaluationConfigId: "config-1", samplingIds: selectedIds, idempotencyKey: "large-selection",
    });
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(4 * 1024 * 1024);
    const response = await api.handle(request("/api/projects/project-1/evaluations", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
    }));
    expect(response.status).toBe(202);
    expect(runtime.evaluate).toHaveBeenCalledExactlyOnceWith({
      projectId: "project-1", evaluationConfigId: "config-1",
      samplingIds: selectedIds, idempotencyKey: "large-selection",
    });
  });

  it("rejects selections too large for one all-selection request without returning a partial list", async () => {
    const { api, catalog, runtime } = fixture();
    const tooMany = Array.from({ length: 10_001 }, (_, index) => `sampling-${index}`);
    catalog.selectAllSuccessfulSamplingIds.mockResolvedValueOnce(tooMany);
    const selection = await api.handle(request("/api/projects/project-1/samplings/successful/ids"));
    expect(selection.status).toBe(413);
    expect(await body(selection)).toEqual({ error: expect.objectContaining({ code: "SELECTION_TOO_LARGE" }) });
    const submit = await api.handle(request("/api/projects/project-1/evaluations", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        evaluationConfigId: "config-1", samplingIds: tooMany, idempotencyKey: "too-many",
      }),
    }));
    expect(submit.status).toBe(413);
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  it("bounds request buffering at 8 MiB", async () => {
    const { api, runtime } = fixture();
    const response = await api.handle(request("/api/projects/project-1/evaluations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: "x".repeat(8 * 1024 * 1024 + 1),
    }));
    expect(response.status).toBe(413);
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  it("serves the Fetch handler over Node HTTP and handles the trusted Web preflight", async () => {
    const { spClient, createOwnerServices } = fixture();
    const api = createIndependentEvaluationApi({
      spClient, createOwnerServices, webOrigin: "https://eval-web.test",
    });
    const server = createIndependentEvaluationHttpServer(api);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No HTTP address");
      const origin = `http://127.0.0.1:${address.port}`;
      const preflight = await fetch(`${origin}/api/projects/project-1/evaluations`, {
        method: "OPTIONS", headers: { Origin: "https://eval-web.test", "Access-Control-Request-Method": "POST" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("https://eval-web.test");
      const response = await fetch(`${origin}/api/projects/project-1/evaluations`, {
        method: "POST",
        headers: { Authorization: "Bearer alice-token", Origin: "https://eval-web.test", "Content-Type": "application/json" },
        body: JSON.stringify({ evaluationConfigId: "config-1", samplingIds, idempotencyKey: "click-1" }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ runId: "run-1", samplingIds });
      expect((await fetch(`${origin}/api/projects/project-1/samplings/successful`, {
        headers: { Authorization: "Bearer alice-token", Origin: "https://other-web.test" },
      })).status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
