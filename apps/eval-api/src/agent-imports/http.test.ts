import { describe, expect, it, vi } from "vitest";
import type { ApiRuntime, OwnerServices } from "../lib/types.js";
import { jsonRequest, requestApp, WEB_ORIGIN } from "../test-support.js";
import { ImportDependencyError } from "./errors.js";
import { initialView, type ImportTask } from "./model.js";
import { createAgentImportService, createAgentImportTaskReader } from "./service.js";
import type { AgentImportSource } from "./source.js";
import type { AgentImportStore } from "./store.js";
import type { AgentImportTarget } from "./target.js";
import { createAgentImportTarget } from "./target.js";
import type { EvalSpClient } from "../sp/client.js";

const owner = "11111111-1111-4111-8111-111111111111";
const userA = "22222222-2222-4222-8222-222222222222";
const userB = "33333333-3333-4333-8333-333333333333";
const agent = "44444444-4444-4444-8444-444444444444";
const taskId = "55555555-5555-4555-8555-555555555555";
const body = { sourceUserId: userA, agentIds: [agent], purpose: "execution" as const, idempotencyKey: "preview" };
function fixture(enabled = true) {
  const source = {
    origin: "https://dev.test", connectionId: "fixed-export-connection",
    users: vi.fn(async () => [{ id: userA, name: "A", email: "a@example.test" }]),
    agents: vi.fn(async (sourceUserId: string) => ({
      items: [{ id: agent, name: sourceUserId === userA ? "A Agent" : "B Agent", description: null, revision: 2, skillCount: 1, referenceCount: 0 }],
      nextCursor: "next-source-page",
    })),
  };
  let targetEnabled = true;
  let probeStatus = 200;
  const target = createAgentImportTarget({
    origin: "https://eval.test", writeOrigin: WEB_ORIGIN, ownerUserId: owner, sessionToken: "fixed-session",
    sp: { listAgentConfigs: async () => [{ id: agent, user_id: owner, name: "Native" }] } as unknown as EvalSpClient,
    fetch: async (input) => {
      if (new URL(new Request(input).url).pathname !== "/api/agent-config-imports/config") throw new Error("Unexpected target request");
      return probeStatus === 200 ? Response.json({ success: true, msg: { version: 1, enabled: targetEnabled }, code: "", errMsg: "" })
        : Response.json({ code: "AUTH_UNAUTHENTICATED", errMsg: "upstream unauthorized" }, { status: probeStatus });
    },
  });
  const view = initialView(taskId, body, "2099-10-22T00:00:00.000Z");
  const task: ImportTask = { id: taskId, ownerUserId: owner, actorId: "audit", connectionId: source.connectionId, request: body,
    fingerprint: "private-fingerprint", view, snapshot: null, plan: null, applyKey: null, leaseToken: null, expiresAt: view.expiresAt!,
    revision: 0, attempts: 0 };
  const store = { create: vi.fn(async () => task), get: vi.fn(async () => task), apply: vi.fn(async () => task) };
  const service = createAgentImportService({ source: source as unknown as AgentImportSource, target: target as unknown as AgentImportTarget, store: store as unknown as AgentImportStore });
  const nativeList = vi.fn(async () => [{ id: agent, name: "Native", user_id: owner }]);
  const runtime = {
    webOrigin: WEB_ORIGIN,
    serviceAccount: { user: { id: owner, role: "user" }, email: "service@example.test", sessionToken: "service-session" },
    ownerServices: () => ({ services: {
      agentConfigs: { list: nativeList }, agentImportTasks: createAgentImportTaskReader(store as unknown as AgentImportStore),
      ...(enabled ? { agentImports: service } : {}),
    } as unknown as OwnerServices, release: () => {} }),
  } as unknown as ApiRuntime;
  return { request: requestApp(runtime), source, store, view, nativeList,
    setTargetEnabled: (value: boolean) => { targetEnabled = value; }, setProbeStatus: (value: number) => { probeStatus = value; } };
}

describe("Agent import public HTTP control plane", () => {
  it("keeps ordinary Agent reads and startup semantics available while imports are disabled", async () => {
    const f = fixture(false);
    const config = await f.request("/api/agent-config-sync/config");
    expect(await config.json()).toMatchObject({ success: true, msg: { enabled: false, maxAgents: 50 } });
    const list = await f.request("/api/agent-configs");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ msg: [{ id: agent, name: "Native" }] });
    const unavailable = await f.request("/api/agent-config-sync/users?q=Alice");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "EVAL_SP_UNAVAILABLE" });
    expect(f.source.users).not.toHaveBeenCalled();
  });

  it.each(["", "?q=", "?q=%20%20"])("rejects a blank user search locally without calling the source (%s)", async (query) => {
    const f = fixture();
    const response = await f.request(`/api/agent-config-sync/users${query}`);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "REQUEST_VALIDATION_FAILED" });
    expect(f.source.users).not.toHaveBeenCalled();
  });

  it("trims a valid user search before passing it to the authorized source", async () => {
    const f = fixture();
    const response = await f.request("/api/agent-config-sync/users?q=%20Alice%20&limit=20");
    expect(response.status).toBe(200);
    expect(f.source.users).toHaveBeenCalledExactlyOnceWith({ q: "Alice", limit: 20 });
  });

  it("preserves the source cursor on filtered empty pages and scopes changed source users independently", async () => {
    const f = fixture();
    let response = await f.request(`/api/agent-config-sync/users/${userA}/agents?onlyMissing=true&q=one&cursor=old&limit=10`);
    expect(await response.json()).toMatchObject({ msg: { items: [], nextCursor: "next-source-page" } });
    expect(f.source.agents).toHaveBeenLastCalledWith(userA, { q: "one", cursor: "old", limit: 10 });
    response = await f.request(`/api/agent-config-sync/users/${userB}/agents?limit=20`);
    expect(await response.json()).toMatchObject({ msg: { items: [{ id: agent, name: "B Agent", exists: true }] } });
    expect(f.source.agents).toHaveBeenLastCalledWith(userB, { limit: 20 });
  });

  it("returns 202 durable task identities, with no synchronous preparation or client-selected origin/owner/token", async () => {
    const f = fixture();
    const response = await f.request("/api/agent-config-sync/previews", jsonRequest("POST", body, undefined, { Origin: WEB_ORIGIN }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ msg: { taskId } });
    expect(f.store.create).toHaveBeenCalledWith(body, "fixed-export-connection", undefined);
    expect(f.source.agents).not.toHaveBeenCalled();
    for (const extra of [{ origin: "https://evil.test" }, { token: "client-token" }, { ownerUserId: userB }, { targetOwner: userB }]) {
      const denied = await f.request("/api/agent-config-sync/previews", jsonRequest("POST", { ...body, ...extra }));
      expect(denied.status).toBe(422);
    }
    const apply = await f.request(`/api/agent-config-sync/tasks/${taskId}/apply`, jsonRequest("POST", { idempotencyKey: "apply" }));
    expect(apply.status).toBe(202);
    expect(f.store.apply).toHaveBeenCalledWith(taskId, "apply");
  });

  it("projects only task DTOs and does not leak provenance, plans, owner, credentials or intent fingerprints", async () => {
    const f = fixture();
    const response = await f.request(`/api/agent-config-sync/tasks/${taskId}`);
    const json = await response.json();
    expect(json).toMatchObject({ msg: f.view });
    const text = JSON.stringify(json);
    for (const internal of ["ownerUserId", "connectionId", "fingerprint", "service-session", "plan", "receipt"]) expect(text).not.toContain(`"${internal}"`);
    expect(JSON.stringify(await (await f.request("/api/agent-configs")).json())).not.toContain("origin");
  });

  it("never maps source authorization failure to browser session expiry or an empty missing list", async () => {
    const f = fixture();
    f.source.agents.mockRejectedValue(new ImportDependencyError("Authorized source is unavailable"));
    const response = await f.request(`/api/agent-config-sync/users/${userA}/agents`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "EVAL_SP_UNAVAILABLE" });
  });

  it("reflects a disabled real target capability and rejects preview/apply before persistence or enqueue", async () => {
    const f = fixture();
    f.setTargetEnabled(false);
    expect(await (await f.request("/api/agent-config-sync/config")).json()).toMatchObject({ msg: { enabled: false, maxAgents: 50 } });
    expect((await f.request("/api/agent-config-sync/previews", jsonRequest("POST", body))).status).toBe(503);
    expect((await f.request(`/api/agent-config-sync/tasks/${taskId}/apply`, jsonRequest("POST", { idempotencyKey: "apply" }))).status).toBe(503);
    expect(f.store.create).not.toHaveBeenCalled();
    expect(f.store.apply).not.toHaveBeenCalled();
  });

  it("translates capability 401 into dependency unavailability, never browser reauthentication", async () => {
    const f = fixture();
    f.setProbeStatus(401);
    const response = await f.request("/api/agent-config-sync/config");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "EVAL_SP_UNAVAILABLE" });
    expect(f.store.create).not.toHaveBeenCalled();
  });
});
