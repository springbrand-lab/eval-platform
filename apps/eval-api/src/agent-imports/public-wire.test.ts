import { describe, expect, it } from "vitest";
import { createAgentConfigService } from "../agent-configs.js";
import type { AgentPurposeStore } from "../db/agent-purposes.js";
import { createEvalSpClient } from "../sp/client.js";
import { ImportConflictError, ImportDependencyError } from "./errors.js";
import type { SourceAgent } from "./model.js";
import { createAgentImportTarget } from "./target.js";
import type { DefinitionEvidence } from "./definition-evidence.js";
import { canonicalSourceSettingFixture } from "./public-wire.test-support.js";

const owner = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const updatedAt = "2026-10-21T00:00:00.000Z";
const ok = (msg: unknown) => Response.json({ success: true, msg, errMsg: "", code: "" });
// Public HTTP fixtures, not a copy of SP's setting or admission implementation.
const managed = { id: "managed", name: "Managed", description: null, status: "active", revision: 1, updatedAt,
  source: "user", url: "https://external-mcp.test/mcp", authType: "none" };
const resultMcp = { ...managed, id: "toolkit-result-collision", name: "Results",
  url: "https://eval.test/mcp/evaluation-results", authType: "bearer" };
const evidence: DefinitionEvidence[] = [
  { kind: "action", id: "action-selected", fingerprint: "a".repeat(64) },
  { kind: "connector", id: "connector-selected", fingerprint: "c".repeat(64) },
  { kind: "extension", id: "extension-selected", fingerprint: "e".repeat(64) },
];
function sourceFixture(): SourceAgent {
  return { id: agentId, name: "Imported", slug: "original", description: null, revision: 1, setting: {
    ...canonicalSourceSettingFixture(),
    connectorIds: ["connector-selected"], extensionIds: ["extension-selected"], actionIds: ["action-selected"],
    model: "deepseek/deepseek-v4.1-flash", presetId: "deepseek-flash-balanced",
    mcpServers: [{ serverId: "managed" }, { serverId: "toolkit-result-collision", kind: "connector_toolkit" }],
  } };
}

function fixture(source = sourceFixture()) {
  const requests: Request[] = [];
  let rejection: { status: number; code: string } | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); requests.push(request.clone());
    const url = new URL(request.url);
    if (url.pathname === "/api/agent-config-imports/config") return ok({ version: 1, enabled: true });
    if (url.pathname === "/api/agent-config-imports/validate") {
      return rejection ? Response.json({ code: rejection.code, errMsg: "Target admission rejected", requestId: "target-preflight" },
        { status: rejection.status }) : ok({ version: 1, setting: source.setting });
    }
    if (request.method !== "GET") throw new Error("Public catalog checks must not mutate");
    const query = Object.fromEntries(url.searchParams);
    function only(keys: readonly string[]) {
      if (Object.keys(query).some((key) => !keys.includes(key))) throw new Error("Unknown query parameter rejected by strict public SP schema");
    }
    if (url.pathname === "/api/mcp-servers") {
      only(["source", "q", "page", "pageSize"]);
      expect(query.page).toBe("1");
      expect(query.pageSize).toBe("100");
      const data = query.source === "user" ? [managed, resultMcp] : [];
      return ok({ data, total: data.length, page: 1, pageSize: 100 });
    }
    if (url.pathname === "/api/skills") {
      only(["view", "ids", "q", "page", "pageSize"]);
      expect(query.view).toBe("selected");
      expect(query.ids).toBe("platform-stable-string");
      return ok({ data: [{ id: query.ids, name: "platform-demo", description: "", origin: "marketplace",
        available: true, deleted: false, createdAt: updatedAt }], total: 1, page: 1, pageSize: 100 });
    }
    if (url.pathname === "/api/skills/platform-stable-string/files") {
      only([]);
      return ok({ id: "platform-stable-string", name: "platform-demo", usage: { agents: [], total: 0 },
        files: [{ path: "SKILL.md", size: 3, url: "https://cdn.springbrand.ai/skills/platform-demo/SKILL.md" },
          { path: "scripts/运行.py", size: 3, url: "https://cdn.springbrand.ai/skills/platform-demo/scripts/%E8%BF%90%E8%A1%8C.py" }] });
    }
    throw new Error(`Unexpected public route ${url.pathname}`);
  };
  const sp = createEvalSpClient({ origin: "https://eval.test", writeOrigin: "https://eval-web.test", fetch });
  const target = createAgentImportTarget({ origin: "https://eval.test", writeOrigin: "https://eval-web.test",
    ownerUserId: owner, sessionToken: "fixed-target-session", sp, fetch });
  const agents = createAgentConfigService({ ownerUserId: owner, sessionToken: "fixed-target-session", sp,
    imports: target, purposes: {} as AgentPurposeStore, projects: { frozenAgentConfigIds: async () => new Set<string>() } });
  return { source, target, agents, requests, setRejection: (value: { status: number; code: string }) => { rejection = value; } };
}

describe("target adapter against authoritative SP preflight and resource evidence wire fixtures", () => {
  it("uses one complete-setting preflight with expected proofs, not Action/Component/Toolkit/model admission catalogs", async () => {
    const f = fixture();
    const prepared = await f.agents.prepareImport(f.source, "execution", evidence);
    expect(prepared.config.setting).toEqual(f.source.setting);
    const preflight = f.requests.filter((request) => new URL(request.url).pathname === "/api/agent-config-imports/validate");
    expect(preflight).toHaveLength(1);
    expect(await preflight[0]!.clone().json()).toEqual({
      setting: f.source.setting, dependencies: evidence, plannedResources: { skills: [], references: [] },
    });
    expect(preflight[0]!.method).toBe("POST");
    expect(preflight[0]!.headers.get("Origin")).toBe("https://eval-web.test");
    expect(f.requests.filter((request) => new URL(request.url).pathname === "/api/mcp-servers")).toHaveLength(2);
    expect(f.requests.every((request) => ["/api/mcp-servers", "/api/agent-config-imports/config", "/api/agent-config-imports/validate"]
      .includes(new URL(request.url).pathname)
      && request.headers.get("Authorization") === "Bearer fixed-target-session")).toBe(true);
    expect(prepared.dependencies).toEqual(evidence);
  });

  it("preserves Toolkit selections through purpose reconciliation and honors the target's Toolkit rejection", async () => {
    const source = { ...sourceFixture(), setting: { ...canonicalSourceSettingFixture(),
      mcpServers: [{ serverId: "toolkit-result-collision", kind: "connector_toolkit" }] } };
    const f = fixture(source);
    await expect(f.agents.prepareImport(source, "execution")).resolves.toMatchObject({ config: { setting: source.setting } });
    f.setRejection({ status: 409, code: "AGENT_CONFIG_IMPORT_CONFLICT" });
    await expect(f.agents.prepareImport(source, "execution")).rejects.toBeInstanceOf(ImportConflictError);
    expect(f.requests.some((request) => new URL(request.url).pathname === "/api/connectors")).toBe(false);
  });

  it("honors the documented target model-plan rejection without attempting model catalog fallback", async () => {
    const f = fixture();
    f.setRejection({ status: 403, code: "MODEL_ACCESS_DENIED" });
    await expect(f.agents.prepareImport(f.source, "execution", evidence)).rejects.toMatchObject({
      code: "EVAL_SP_CONFLICT", cause: { status: 403, payload: { code: "MODEL_ACCESS_DENIED", requestId: "target-preflight" } },
    });
    expect(f.requests.some((request) => new URL(request.url).pathname === "/api/model-catalog")).toBe(false);
  });

  it("keeps a missing preflight unavailable rather than reconstructing admission from public catalogs", async () => {
    const f = fixture();
    f.setRejection({ status: 404, code: "REQUEST_NOT_FOUND" });
    await expect(f.target.validateSelections(f.source.setting, evidence)).rejects.toBeInstanceOf(ImportDependencyError);
    expect(f.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/agent-config-imports/config", "/api/agent-config-imports/validate",
    ]);
  });

  it("keeps selected Skill queries distinct from Component queries and reads every public Skill file", async () => {
    const f = fixture();
    await expect(f.target.skill("platform-stable-string")).resolves.toMatchObject({
      id: "platform-stable-string", origin: "marketplace", files: [{ path: "SKILL.md" }, { path: "scripts/运行.py" }],
    });
  });
});
