import type { AgentImportCandidatePage, AgentImportPreview, AgentImportTaskView } from "@eval-platform/eval-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000003";
const task: AgentImportTaskView = {
  id: taskId, sourceUserId: userId, purpose: "evaluation", status: "checking",
  agents: [{ id: agentId, name: "Source Agent", status: "pending", skillCount: 2, referenceCount: 1 }],
  progress: { stage: "checking", completed: 0, total: 1, bytesRead: 0, totalBytes: 100 },
  summary: { created: 0, skipped: 0, failed: 0, conflicts: 0 },
};
function ok(msg: unknown, status = 200) { return Response.json({ success: true, msg }, { status }); }

describe("Agent import SDK public HTTP seam", () => {
  beforeEach(async () => {
    vi.resetModules();
    (await import("@/auth/session")).resetAuthForTest({ status: "ready", token: "fixture-eval-token" });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    (await import("@/auth/session")).resetAuthForTest();
    vi.resetModules();
  });

  it("reads config, paginated users without a search query, existing same-ID candidates and tasks through the existing client", async () => {
    const requests: Request[] = [];
    const candidatePage: AgentImportCandidatePage = {
      items: [{ id: agentId, name: "Source Agent", description: "", revision: 3, skillCount: 2, referenceCount: 1, exists: true }],
      nextCursor: "next/page?2",
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(request.headers.get("Authorization")).toBe("Bearer fixture-eval-token");
      expect(url.origin).toBe(window.location.origin);
      if (url.pathname.endsWith("/config")) return ok({ enabled: true, maxAgents: 50 });
      if (url.pathname.endsWith("/users")) return ok({
        users: [{ id: userId, name: "Dev User", email: "user@example.test" }],
        nextCursor: url.searchParams.has("cursor") ? null : "users/page?2 + 中文",
      });
      if (url.pathname.endsWith("/agents")) return ok(candidatePage);
      return ok(task);
    });
    vi.stubGlobal("fetch", fetcher);
    // The installed HTTP client captures fetch at construction, so stub before loading the SDK.
    const { getAgentImportConfig, listAgentImportUsers, listAgentImportCandidates, getAgentImportTask } = await import("./agent-imports-api");
    const controller = new AbortController();
    await expect(getAgentImportConfig(controller.signal)).resolves.toEqual({ enabled: true, maxAgents: 50 });
    await expect(listAgentImportUsers({ limit: 20 }, controller.signal)).resolves.toEqual({
      users: [{ id: userId, name: "Dev User", email: "user@example.test" }], nextCursor: "users/page?2 + 中文",
    });
    await expect(listAgentImportUsers({ limit: 20, cursor: "users/page?2 + 中文" }, controller.signal)).resolves.toEqual({
      users: [{ id: userId, name: "Dev User", email: "user@example.test" }], nextCursor: null,
    });
    await expect(listAgentImportCandidates(userId, { q: "Agent + 名称", limit: 20 }, controller.signal))
      .resolves.toEqual(candidatePage);
    await expect(listAgentImportCandidates(userId, { q: "Agent + 名称", cursor: "next/page?2", limit: 20 }, controller.signal))
      .resolves.toEqual(candidatePage);
    await expect(getAgentImportTask(taskId, controller.signal)).resolves.toEqual(task);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/agent-config-sync/config", "/api/agent-config-sync/users", "/api/agent-config-sync/users",
      `/api/agent-config-sync/users/${userId}/agents`, `/api/agent-config-sync/users/${userId}/agents`,
      `/api/agent-config-sync/tasks/${taskId}`,
    ]);
    expect(Object.fromEntries(new URL(requests[1]!.url).searchParams)).toEqual({ limit: "20" });
    expect(Object.fromEntries(new URL(requests[2]!.url).searchParams)).toEqual({ limit: "20", cursor: "users/page?2 + 中文" });
    expect(Object.fromEntries(new URL(requests[3]!.url).searchParams)).toEqual({ q: "Agent + 名称", limit: "20" });
    expect(Object.fromEntries(new URL(requests[4]!.url).searchParams)).toEqual({
      q: "Agent + 名称", limit: "20", cursor: "next/page?2",
    });
    expect(requests.every((request) => !request.signal.aborted)).toBe(true);
  });

  it("posts only public preview roots/scope/purpose and the caller's fixed apply key, accepting 202", async () => {
    const bodies: unknown[] = [];
    const paths: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.method).toBe("POST");
      paths.push(new URL(request.url).pathname);
      bodies.push(await request.json());
      return ok({ taskId }, 202);
    });
    vi.stubGlobal("fetch", fetcher);
    const { previewAgentImport, applyAgentImport } = await import("./agent-imports-api");
    const input: AgentImportPreview = { sourceUserId: userId, agentIds: [agentId], purpose: "evaluation", idempotencyKey: "preview-fixed" };
    await expect(previewAgentImport(input)).resolves.toEqual({ taskId });
    await expect(applyAgentImport(taskId, { idempotencyKey: "apply-fixed" })).resolves.toEqual({ taskId });
    expect(bodies).toEqual([input, { idempotencyKey: "apply-fixed" }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(paths).toEqual(["/api/agent-config-sync/previews", `/api/agent-config-sync/tasks/${taskId}/apply`]);
  });

  it.each(["network", "unavailable"] as const)("does not retry or hide an uncertain POST (%s)", async (failure) => {
    const fetcher = vi.fn(async () => {
      if (failure === "network") throw new TypeError("fixture connection lost");
      return Response.json({ code: "EVAL_SP_UNAVAILABLE", errMsg: "source unavailable" }, { status: 503 });
    });
    vi.stubGlobal("fetch", fetcher);
    const { applyAgentImport } = await import("./agent-imports-api");
    await expect(applyAgentImport(taskId, { idempotencyKey: "fixed" })).rejects.toMatchObject({
      status: failure === "network" ? 0 : 503,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["failed", "completed_with_errors", "outcome_unknown"] as const)("preserves %s instead of inventing success", async (status) => {
    const view: AgentImportTaskView = { ...task, status, error: "原始失败原因" };
    vi.stubGlobal("fetch", vi.fn(async () => ok(view)));
    const { getAgentImportTask } = await import("./agent-imports-api");
    await expect(getAgentImportTask(taskId)).resolves.toEqual(view);
  });

  it.each(["users", "agents"] as const)("forwards cancellation to an in-flight %s read without performing another request", async (resource) => {
    let request!: Request;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const { listAgentImportUsers, listAgentImportCandidates } = await import("./agent-imports-api");
    const controller = new AbortController();
    const pending = resource === "users"
      ? listAgentImportUsers({ limit: 20, cursor: "users/page?2" }, controller.signal)
      : listAgentImportCandidates(userId, { q: "", limit: 20 }, controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort();
    await rejection;
    expect(request.signal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
