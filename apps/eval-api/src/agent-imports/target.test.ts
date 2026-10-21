import { describe, expect, it, vi } from "vitest";
import type { EvalSpClient } from "../sp/client.js";
import { EvalSpApiError } from "../sp/http.js";
import { ImportConflictError, ImportDependencyError, ImportOutcomeUnknownError } from "./errors.js";
import { createAgentImportTarget } from "./target.js";
import type { ImportResult, PreparedAgent } from "./model.js";

const id = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const prepared: PreparedAgent = { purpose: "execution", evaluationMcpServerId: null, dependencies: [],
  config: { id, slug: `import-${id}`, name: "A", description: null, setting: { skillIds: ["platform-string"], mcpServers: [] } } };
const receipt = { id: "33333333-3333-4333-8333-333333333333", resourceKind: "agent" as const, resourceId: id,
  importKey: "key", fingerprint: "server-fingerprint", createdAt: "2026-10-21T00:00:00Z" };
const result: ImportResult = { receipt, replayed: false, resource: { ...prepared.config, user_id: owner } };
const ok = (msg: unknown) => Response.json({ success: true, msg, code: "", errMsg: "" });
const missing = () => Response.json({ code: "IMPORT_RECEIPT_NOT_FOUND", errMsg: "missing" }, { status: 404 });
function setup(fetch: typeof globalThis.fetch) {
  return createAgentImportTarget({ origin: "https://eval.test", sourceOrigin: "https://dev.test", writeOrigin: "https://web.test",
    ownerUserId: owner, sessionToken: "target-session", sp: {} as EvalSpClient,
    // Receipt/write tests use the real versioned capability wire; dedicated tests exercise negative probes.
    fetch: (input, init) => new URL(input instanceof Request ? input.url : String(input)).pathname === "/api/agent-config-imports/config"
      ? Promise.resolve(ok({ version: 1, enabled: true })) : fetch(input, init),
  });
}

describe("fixed create-only target HTTP seam", () => {
  it("uses the original Agent UUID, import key and target credential/origin", async () => {
    const calls: Request[] = [];
    const target = setup(async (input, init) => {
      const request = new Request(input, init); calls.push(request);
      return request.method === "GET" ? missing() : ok(result);
    });
    await expect(target.importAgent(prepared, "key")).resolves.toEqual(result);
    expect(calls.map((item) => [item.method, item.url])).toEqual([
      ["GET", "https://eval.test/api/agent-config-imports/receipts/key?kind=agent"],
      ["POST", "https://eval.test/api/user-agent-configs/imports"],
    ]);
    expect(await calls[1]!.json()).toEqual({ ...prepared.config, dependencies: [], importKey: "key" });
    expect(calls[1]!.headers.get("Origin")).toBe("https://web.test");
    expect(calls[1]!.headers.get("Authorization")).toBe("Bearer target-session");
  });

  it("calibrates a lost POST response only through the same key's durable receipt", async () => {
    let submitted = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST") { submitted = true; throw new TypeError("response lost"); }
      return submitted ? ok({ ...result, replayed: true }) : missing();
    });
    await expect(setup(fetch).importAgent(prepared, "key")).resolves.toMatchObject({ replayed: true, receipt });
    expect(fetch.mock.calls.filter(([input, init]) => (input instanceof Request ? input.method : init?.method) === "POST")).toHaveLength(1);
    fetch.mockClear();
    await expect(setup(fetch).importAgent(prepared, "key")).resolves.toMatchObject({ receipt });
    expect(fetch.mock.calls.every(([input, init]) => (input instanceof Request ? input.method : init?.method) === "GET")).toBe(true);
  });

  it("never treats ID/content equality without a receipt as a successful uncertain write", async () => {
    const target = setup(async (input, init) => {
      if (new Request(input, init).method === "POST") throw new TypeError("lost response");
      return missing();
    });
    await expect(target.importAgent(prepared, "key")).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
  });

  it.each([
    { ...result, receipt: { ...receipt, importKey: "another" } },
    { ...result, receipt: { ...receipt, resourceId: owner } },
    { ...result, resource: { ...result.resource, user_id: id } },
    { ...result, resource: { ...result.resource, setting: { skillIds: [] } } },
  ])("rejects a mismatched receipt or another owner/current payload", async (value) => {
    await expect(setup(async () => ok(value)).importAgent(prepared, "key")).rejects.toBeInstanceOf(ImportConflictError);
  });

  it.each([
    { status: 401, body: { code: "REQUEST_CONFLICT", errMsg: "private" } },
    { status: 403, body: { code: "AGENT_CONFIG_IMPORT_CONFLICT", errMsg: "private" } },
    { status: 409, body: { code: "UNAVAILABLE", errMsg: "private" } },
    { status: 409, body: { code: ["REQUEST_CONFLICT"], errMsg: "private" } },
    { status: 409, body: '{"code":"REQUEST_CONFLICT"' },
    { status: 503, body: { code: "REQUEST_CONFLICT", errMsg: "private" } },
    { status: 200, body: { success: true, msg: { code: "REQUEST_CONFLICT" }, code: "", errMsg: "" } },
  ])("keeps receipt/upload HTTP $status ($body) unavailable, not conflicted", async ({ status, body }) => {
    const target = setup(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    }));
    await expect(target.receipt("agent", "key")).rejects.toBeInstanceOf(ImportDependencyError);
    await expect(target.uploadReference(id, "brief.txt", "text/plain", new Uint8Array([1, 2, 3])))
      .rejects.toBeInstanceOf(ImportDependencyError);
  });

  it.each(["AGENT_CONFIG_IMPORT_CONFLICT", "REQUEST_CONFLICT"])("preserves immutable Reference upload conflicts and their safe upstream cause (%s)", async (code) => {
    const calls: Request[] = [];
    const target = setup(async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({
        code, errMsg: "private upstream details", requestId: "upload-request",
      }, { status: 409 });
    });
    const error = await target.uploadReference(id, "brief.txt", "text/plain", new Uint8Array([1, 2, 3]))
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ImportConflictError);
    expect(error).toMatchObject({ status: 409, code: "EVAL_SP_CONFLICT", cause: expect.any(EvalSpApiError) });
    expect((error as Error).cause).toMatchObject({ status: 409, payload: {
      code, requestId: "upload-request",
    } });
    expect((error as Error).message).not.toContain("private upstream details");
    expect(calls.map((request) => [request.method, request.url])).toEqual([
      ["POST", "https://eval.test/api/inbox/attachments"],
    ]);
    expect((await calls[0]!.formData()).get("clientAttachmentId")).toBe(id);
  });

  it.each(["AGENT_CONFIG_IMPORT_CONFLICT", "REQUEST_CONFLICT"])("preserves authoritative receipt %s and its safe upstream cause", async (code) => {
    const target = setup(async () => Response.json({
      code, errMsg: "private upstream details", requestId: "receipt-request",
    }, { status: 409 }));
    const error = await target.receipt("agent", "key").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ImportConflictError);
    expect((error as Error).cause).toBeInstanceOf(EvalSpApiError);
    expect((error as Error).cause).toMatchObject({ status: 409, payload: {
      code, requestId: "receipt-request",
    } });
    expect((error as Error).message).not.toContain("private upstream details");
  });

  it.each([
    { recovering: false, code: "AGENT_CONFIG_IMPORT_CONFLICT" },
    { recovering: true, code: "AGENT_CONFIG_IMPORT_CONFLICT" },
    { recovering: false, code: "REQUEST_CONFLICT" },
    { recovering: true, code: "REQUEST_CONFLICT" },
  ])("does not hide receipt $code during POST recovery=$recovering", async ({ recovering, code }) => {
    let submitted = false;
    const calls: Request[] = [];
    const target = setup(async (input, init) => {
      const request = new Request(input, init); calls.push(request);
      if (request.method === "POST") { submitted = true; throw new TypeError("lost response"); }
      if (recovering && !submitted) return missing();
      return Response.json({ code, errMsg: "changed" }, { status: 409 });
    });
    await expect(target.importAgent(prepared, "key")).rejects.toBeInstanceOf(ImportConflictError);
    expect(calls.filter((request) => request.method === "POST")).toHaveLength(recovering ? 1 : 0);
  });

  it("keeps a missing receipt null and receipt/upload network failures unavailable", async () => {
    await expect(setup(async () => missing()).receipt("agent", "key")).resolves.toBeNull();
    const offline = setup(async () => { throw new TypeError("offline"); });
    await expect(offline.receipt("agent", "key"))
      .rejects.toBeInstanceOf(ImportDependencyError);
    await expect(offline.uploadReference(id, "brief.txt", "text/plain", new Uint8Array([1, 2, 3])))
      .rejects.toBeInstanceOf(ImportDependencyError);
  });

  it.each(["ID_CONFLICT", "AGENT_CONFIG_IMPORT_CONFLICT", "REQUEST_CONFLICT"])("rejects create-only import 409 %s without a replacement ID, DELETE, PATCH, or fallback upload", async (code) => {
    const calls: Request[] = [];
    const target = setup(async (input, init) => {
      const request = new Request(input, init); calls.push(request);
      return request.method === "GET" ? missing() : Response.json({ code, errMsg: "occupied" }, { status: 409 });
    });
    const error = await target.importSkill("platform-string", new Uint8Array([1, 2, 3]), "key").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ImportConflictError);
    expect((error as Error).cause).toBeInstanceOf(EvalSpApiError);
    expect((error as Error).cause).toMatchObject({ status: 409, payload: { code } });
    expect(calls.map((item) => item.method)).toEqual(["GET", "POST"]);
    expect(new URL(calls[1]!.url).pathname).toBe("/api/skills/imports");
    expect(new URL(calls[1]!.url).searchParams.get("skillId")).toBe("platform-string");
  });

  it("checks target model provider IDs/presets and paginated Component capabilities without dropping them", async () => {
    const proof = { kind: "connector" as const, id: "connector", fingerprint: "a".repeat(64) };
    const target = setup(async (input) => {
      const url = new URL(new Request(input).url);
      if (url.pathname === "/api/agent-config-imports/dependencies") return ok({ items: [proof] });
      if (url.pathname === "/api/model-catalog") return ok([{ id: "preset", providerModel: "provider/model", available: true }]);
      const page = Number(url.searchParams.get("page") ?? "1");
      return ok({ data: page === 1 ? [{ id: "unrelated", status: "active", selectable: true }] : [{ id: "connector", status: "active", selectable: true }],
        total: 2, page, pageSize: 1 });
    });
    await expect(target.validateSelections({ model: "provider/model", presetId: "preset", connectorIds: ["connector"] }, [proof])).resolves.toBeUndefined();
    await expect(target.validateSelections({ model: "missing" })).rejects.toBeInstanceOf(ImportConflictError);
    await expect(target.validateSelections({ presetId: "missing" })).rejects.toBeInstanceOf(ImportConflictError);
  });
});
