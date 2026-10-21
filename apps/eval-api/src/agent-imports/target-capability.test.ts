import { describe, expect, it } from "vitest";
import type { EvalSpClient } from "../sp/client.js";
import { ImportDependencyError, ImportTargetDisabledError } from "./errors.js";
import { createAgentImportTarget } from "./target.js";
import type { PreparedAgent } from "./model.js";

const owner = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const prepared: PreparedAgent = { purpose: "execution", evaluationMcpServerId: null, dependencies: [],
  config: { id, slug: `import-${id}`, name: "Imported", description: null, setting: {} } };
const attachment = { attachmentCdnUrl: `https://evalworkspace.springbrand.ai/uploads/v1/${owner}/${id}`,
  clientAttachmentId: id, name: "brief.txt", mediaType: "text/plain", size: 3 };
const ok = (msg: unknown) => Response.json({ success: true, msg, code: "", errMsg: "" });
function fixture() {
  let enabled = true;
  let status = 200;
  let version: unknown = 1;
  const requests: Request[] = [];
  const target = createAgentImportTarget({ origin: "https://eval.test", sourceOrigin: "https://dev.test",
    writeOrigin: "https://eval-web.test", ownerUserId: owner, sessionToken: "fixed-target-session", sp: {} as EvalSpClient,
    fetch: async (input, init) => {
      const request = new Request(input, init); requests.push(request.clone());
      const url = new URL(request.url);
      if (url.pathname === "/api/agent-config-imports/config") {
        return status === 200 ? ok({ version, enabled }) : Response.json({ code: "AUTH_UNAUTHENTICATED", errMsg: "unavailable" }, { status });
      }
      if (url.pathname.includes("/receipts/")) return Response.json({ code: "AGENT_CONFIG_IMPORT_RECEIPT_NOT_FOUND", errMsg: "missing" }, { status: 404 });
      if (url.pathname === "/api/skills/imports") return ok({
        receipt: { id: crypto.randomUUID(), resourceKind: "skill", resourceId: "stable-skill",
          importKey: "skill-key", fingerprint: "opaque-server-fingerprint", createdAt: new Date().toISOString() },
        replayed: false, resource: { id: "stable-skill", name: "skill" },
      });
      throw new Error(`Unexpected target write ${request.method} ${url.pathname}`);
    },
  });
  return { target, requests, setEnabled: (value: boolean) => { enabled = value; },
    setStatus: (value: number) => { status = value; }, setVersion: (value: unknown) => { version = value; } };
}

describe("fixed target import capability guard", () => {
  it("reads the frozen capability wire using only the fixed target credential, never browser auth or another owner", async () => {
    const f = fixture();
    f.setEnabled(false);
    await expect(f.target.config()).resolves.toEqual({ version: 1, enabled: false });
    expect(f.requests.map((request) => [request.method, request.url])).toEqual([["GET", "https://eval.test/api/agent-config-imports/config"]]);
    expect(f.requests[0]!.headers.get("Authorization")).toBe("Bearer fixed-target-session");
    expect(f.requests[0]!.headers.has("Origin")).toBe(false);
  });

  it("never treats a successful earlier probe as permission for later Skill, Reference, attachment or Agent writes", async () => {
    const f = fixture();
    await f.target.requireEnabled();
    f.setEnabled(false);
    await expect(f.target.importSkill("stable-skill", new Uint8Array([1]), "skill-key")).rejects.toBeInstanceOf(ImportTargetDisabledError);
    await expect(f.target.uploadReference(id, "brief.txt", "text/plain", new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(ImportTargetDisabledError);
    await expect(f.target.importReference(id, attachment, "ref-key")).rejects.toBeInstanceOf(ImportTargetDisabledError);
    await expect(f.target.importAgent(prepared, "agent-key")).rejects.toBeInstanceOf(ImportTargetDisabledError);
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    expect(f.requests.filter((request) => new URL(request.url).pathname === "/api/agent-config-imports/config")).toHaveLength(5);
  });

  it("rechecks capability before the attachment POST even after an earlier dependency was imported", async () => {
    const f = fixture();
    await f.target.importSkill("stable-skill", new Uint8Array([1]), "skill-key");
    f.setEnabled(false);
    await expect(f.target.uploadReference(id, "brief.txt", "text/plain", new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(ImportTargetDisabledError);
    expect(f.requests.filter((request) => request.method === "POST").map((request) => new URL(request.url).pathname)).toEqual(["/api/skills/imports"]);
  });

  it.each([401, 403, 503])("translates capability HTTP %i to a dependency failure without any POST", async (status) => {
    const f = fixture();
    f.setStatus(status);
    await expect(f.target.uploadReference(id, attachment.name, attachment.mediaType, new Uint8Array([1, 2, 3])))
      .rejects.toMatchObject({ status: 503, code: "EVAL_SP_UNAVAILABLE" });
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("fails closed on an unsupported capability version", async () => {
    const f = fixture();
    f.setVersion(2);
    await expect(f.target.uploadReference(id, attachment.name, attachment.mediaType, new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(ImportDependencyError);
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  });
});
