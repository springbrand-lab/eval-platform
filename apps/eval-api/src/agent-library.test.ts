import { decodeError } from "@eval-platform/eval-contracts/http-errors";
import { describe, expect, it, vi } from "vitest";
import type { ApiRuntime } from "./lib/types.js";
import { ZIP_ARCHIVE_BYTES } from "./limits.js";
import { createEvalSpClient } from "./sp/client.js";
import { jsonRequest, requestApp, WEB_ORIGIN } from "./test-support.js";

const agentId = "00000000-0000-4000-8000-000000000001";
const activeChatId = "00000000-0000-4000-8000-000000000002";
const envelope = (msg: unknown) => Response.json({ success: true, msg, errMsg: "", code: "" });

/** Exercise the real HTTP gateway and SP transport, replacing only the remote server. */
function setup(...responses: Response[]) {
  const calls: Request[] = [];
  const sp = createEvalSpClient({
    origin: "https://eval-sp.test", writeOrigin: WEB_ORIGIN,
    fetch: vi.fn(async (input, init) => {
      calls.push(new Request(input, init));
      return responses.shift() ?? envelope({ id: "saved" });
    }),
  });
  const runtime = {
    webOrigin: WEB_ORIGIN, webApiToken: "web-gateway-key", sp,
    serviceAccount: { user: { id: "service-user", role: "user" }, sessionToken: "service-session", email: "service@test" },
    ownerServices: () => ({ services: { agentConfigs: { remove: (id: string) => sp.deleteAgentConfig("service-session", id) } }, release: () => undefined }),
  } as unknown as ApiRuntime;
  const request = requestApp(runtime);
  return {
    calls,
    request: (path: string, init: RequestInit = {}) => request(path, {
      ...init, headers: { "X-Eval-Web-Token": "web-gateway-key", ...init.headers },
    }),
    anonymous: request,
  };
}

describe("shared Agent editor HTTP gateway", () => {
  it("preserves catalog filters and uses only the fixed service account", async () => {
    const app = setup(envelope({ data: [], total: 0, page: 1, pageSize: 50 }));
    const search = "?view=selected&ids=skill%2B1&ids=skill%202&page=1&pageSize=50";
    const result = await app.request(`/api/agent-library/skills${search}`, { headers: { Authorization: "Bearer caller-token" } });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ success: true, msg: { data: [] } });
    expect(app.calls[0]!.url).toBe(`https://eval-sp.test/api/skills${search}`);
    expect(app.calls[0]!.headers.get("Authorization")).toBe("Bearer service-session");
    expect(app.calls[0]!.headers.has("X-Eval-Web-Token")).toBe(false);
    expect(app.calls[0]!.headers.has("Origin")).toBe(false);
  });

  it("reads one selected MCP Server read-only", async () => {
    const id = "d75b2a66-08b3-4c7c-acf2-79d17110d663";
    const app = setup(envelope({ id, name: "Eval 结果提交", source: "user", status: "active", authType: "bearer" }));
    const result = await app.request(`/api/agent-library/mcp-servers/${id}`);
    expect(result.status).toBe(200);
    expect(app.calls[0]!.url).toBe(`https://eval-sp.test/api/mcp-servers/${id}`);
    expect(app.calls[0]!.method).toBe("GET");
    expect((await app.request(`/api/agent-library/mcp-servers/${id}`, { method: "PATCH" })).status).toBe(404);
  });

  it("lists user MCP Servers for the Eval Agent purpose selector", async () => {
    const app = setup(envelope({ data: [{ id: "result-mcp", source: "user", name: "Eval 结果提交", description: "submit_evaluation", status: "active", url: "https://evalapi.example/mcp/evaluation-results", authType: "bearer", revision: 1, updatedAt: "2026-10-17T00:00:00.000Z" }], total: 1, page: 1, pageSize: 100 }));
    const result = await app.request("/api/agent-library/mcp-servers?source=user&page=1&pageSize=100");
    expect(result.status).toBe(200);
    expect(app.calls[0]!.url).toBe("https://eval-sp.test/api/mcp-servers?source=user&page=1&pageSize=100");
    expect(app.calls[0]!.method).toBe("GET");
    expect((await result.json())).toMatchObject({ success: true, msg: { total: 1 } });
  });

  it("forwards exact Skill archive bytes and the write Origin", async () => {
    const app = setup();
    const bytes = new Uint8Array([80, 75, 0, 1, 255]);
    const response = await app.request("/api/agent-library/skills", {
      method: "POST", headers: { Origin: WEB_ORIGIN, "Content-Type": "application/zip" }, body: bytes,
    });
    expect(response.status).toBe(200);
    expect(app.calls).toHaveLength(1);
    const upstream = app.calls[0]!;
    expect(upstream.url).toBe("https://eval-sp.test/api/skills");
    expect(upstream.headers.get("Authorization")).toBe("Bearer service-session");
    expect(upstream.headers.get("Origin")).toBe(WEB_ORIGIN);
    expect(upstream.headers.get("Content-Type")).toBe("application/zip");
    expect(new Uint8Array(await upstream.arrayBuffer())).toEqual(bytes);
  });

  it("preserves Reference multipart file bytes, name and attachment identity", async () => {
    const app = setup();
    const body = new FormData();
    const bytes = new Uint8Array([0, 255, 1]);
    body.append("file", new Blob([bytes], { type: "application/octet-stream" }), "raw.bin");
    body.append("name", "raw.bin");
    body.append("clientAttachmentId", "attachment-a");
    const response = await app.request("/api/agent-library/inbox/attachments", { method: "POST", headers: { Origin: WEB_ORIGIN }, body });
    expect(response.status).toBe(200);
    const upstream = app.calls[0]!;
    expect(upstream.headers.get("Content-Type")).toContain("multipart/form-data; boundary=");
    const received = await upstream.formData();
    expect(received.get("name")).toBe("raw.bin");
    expect(received.get("clientAttachmentId")).toBe("attachment-a");
    const file = received.get("file") as File;
    expect(file.name).toBe("raw.bin");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("forwards public JSON operations after strict JSON validation", async () => {
    const app = setup();
    const input = { toolkitId: "google-drive", returnTo: "/agents/new" };
    const response = await app.request("/api/agent-library/connectors/attempts", jsonRequest("POST", input));
    expect(response.status).toBe(200);
    expect(app.calls[0]!.url).toBe("https://eval-sp.test/api/connectors/attempts");
    expect(await app.calls[0]!.json()).toEqual(input);
    const invalid = await app.request("/api/agent-library/connectors/attempts", jsonRequest("POST", '{"toolkitId":"a","toolkitId":"b"}'));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "REQUEST_INVALID_JSON" });
    expect(app.calls).toHaveLength(1);
  });

  it("rejects unauthorized requests, foreign Origins and Config write bypasses", async () => {
    const app = setup();
    expect((await app.anonymous("/api/agent-library/models")).status).toBe(401);
    expect((await app.request("/api/agent-library/skills", { headers: { Origin: "https://other.test" } })).status).toBe(403);
    expect((await app.request("/api/agent-library/user-agent-configs", jsonRequest("POST", {}))).status).toBe(404);
    expect((await app.request(`/api/agent-library/user-agent-configs/${agentId}`, jsonRequest("PATCH", {}))).status).toBe(404);
    expect(app.calls).toHaveLength(0);
  });

  it("bounds archives and rejects unsupported upload bodies before SP is called", async () => {
    const app = setup();
    const unsupported = await app.request("/api/agent-library/skills", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "zip" });
    expect(unsupported.status).toBe(415);
    const oversized = await app.request("/api/agent-library/skills", {
      method: "POST", headers: { "Content-Type": "application/zip" }, body: new Uint8Array(ZIP_ARCHIVE_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
    expect(app.calls).toHaveLength(0);
  });

  it("preserves a raced deletion blocker and its validated public details across both HTTP boundaries", async () => {
    const details = { allowed: false, activeChatIds: [activeChatId], enabledScheduleIds: [], unfinishedRunIds: [] };
    const app = setup(
      envelope({ allowed: true, activeChatIds: [], enabledScheduleIds: [], unfinishedRunIds: [] }),
      Response.json({ code: "AGENT_CONFIG_ACTIVE_CHAT", errMsg: "Finish active Chat work", details, requestId: "sp-request-1" }, { status: 409 }),
    );
    expect((await app.request(`/api/agent-library/user-agent-configs/${agentId}/deletion-check`)).status).toBe(200);
    const result = await app.request(`/api/agent-configs/${agentId}`, { method: "DELETE" });
    expect(result.status).toBe(409);
    const payload = await result.json();
    expect(payload).toMatchObject({ code: "AGENT_CONFIG_ACTIVE_CHAT", details });
    const browser = decodeError(payload, { status: result.status, headers: {} });
    expect(browser.code).toBe("AGENT_CONFIG_ACTIVE_CHAT");
    expect(browser.details).toEqual(details);
  });

  it("drops invalid domain details and keeps service authentication and transport outages as dependencies", async () => {
    const app = setup(
      Response.json({ code: "AGENT_CONFIG_ACTIVE_CHAT", errMsg: "Blocked", details: { token: "private" } }, { status: 409 }),
      Response.json({ code: "AUTH_UNAUTHENTICATED", errMsg: "Service session expired" }, { status: 401 }),
      Response.json({ code: "DATABASE_UNAVAILABLE", errMsg: "private storage detail" }, { status: 503 }),
    );
    const blocked = await app.request(`/api/agent-configs/${agentId}`, { method: "DELETE" });
    const blockedPayload = await blocked.json();
    expect(blockedPayload).toMatchObject({ code: "AGENT_CONFIG_ACTIVE_CHAT" });
    expect(blockedPayload).not.toHaveProperty("details");
    expect(JSON.stringify(blockedPayload)).not.toContain("private");
    const expired = await app.request("/api/agent-library/models");
    expect(expired.status).toBe(503);
    expect(await expired.json()).toMatchObject({ code: "EVAL_SP_UNAVAILABLE" });
    const unavailable = await app.request("/api/agent-library/models");
    expect(unavailable.status).toBe(502);
    expect(JSON.stringify(await unavailable.json())).not.toContain("private");
  });
});
