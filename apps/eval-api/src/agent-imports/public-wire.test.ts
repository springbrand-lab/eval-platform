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
// Public fixtures follow agent-contracts/{component,action,mcp,model,skill} and contracts/connectors.
// They are HTTP data, not an Eval copy of SP's setting or permission schema.
const model = { id: "deepseek-flash-balanced", name: "Lite", providerModel: "deepseek/deepseek-v4.1-flash",
  thinking: "high", executionLevel: "high", default: true, requiredPlan: "free", available: true };
function component(id: string, kind: string) {
  return { id, kind, name: id, description: "", status: "active", selectable: true };
}
function toolkit(toolkitId: string, status = "not_connected") {
  return { toolkitId, name: toolkitId, description: "", icon: null, credentialSource: "user_connection", status, connections: [] };
}
const managed = { id: "managed", name: "Managed", description: null, status: "active", revision: 1, updatedAt,
  source: "user", url: "https://external-mcp.test/mcp", authType: "none" };
const resultMcp = { ...managed, id: "toolkit-result-collision", name: "Results",
  url: "https://eval.test/mcp/evaluation-results", authType: "bearer" };
const evidence: DefinitionEvidence[] = [
  { kind: "action", id: "action-selected", fingerprint: "a".repeat(64) },
  { kind: "connector", id: "connector-selected", fingerprint: "c".repeat(64) },
  { kind: "extension", id: "extension-selected", fingerprint: "e".repeat(64) },
];

function fixture() {
  const requests: Request[] = [];
  let actionSelectable = true;
  let actionStatus = 200;
  let modelArray = true;
  let toolkitStatus = "not_connected";
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); requests.push(request.clone());
    const url = new URL(request.url);
    if (url.pathname === "/api/agent-config-imports/config") return ok({ version: 1, enabled: true });
    if (url.pathname === "/api/agent-config-imports/dependencies") {
      expect(request.method).toBe("POST"); // Read-only public metadata query, never a resource write.
      expect(request.headers.get("Origin")).toBe("https://eval-web.test");
      const { resources } = await request.json() as { resources: { kind: string; id: string }[] };
      return ok({ items: resources.map((resource) => evidence.find((item) => item.kind === resource.kind && item.id === resource.id)) });
    }
    if (request.method !== "GET") throw new Error("Public catalog checks must not mutate");
    const query = Object.fromEntries(url.searchParams);
    function only(keys: readonly string[]) {
      if (Object.keys(query).some((key) => !keys.includes(key))) throw new Error("Unknown query parameter rejected by strict public SP schema");
    }
    if (url.pathname === "/api/components") {
      only(["kind", "q", "page", "pageSize"]);
      expect(query.pageSize).toBe("100");
      const page = Number(query.page);
      const kind = query.kind!;
      const data = kind === "connector" && page === 1
        ? Array.from({ length: 100 }, (_, index) => component(`unrelated-${index}`, kind))
        : [component(`${kind}-selected`, kind)];
      return ok({ data, total: kind === "connector" ? 101 : 1, page, pageSize: 100 });
    }
    if (url.pathname === "/api/actions/action-selected") {
      only([]);
      if (actionStatus !== 200) return Response.json({ code: actionStatus === 404 ? "REQUEST_NOT_FOUND" : "AUTH_UNAUTHENTICATED", errMsg: "unavailable" }, { status: actionStatus });
      return ok({ id: "action-selected", name: "Action", description: "", status: actionSelectable ? "active" : "deprecated",
        selectable: actionSelectable, supplier: null });
    }
    if (url.pathname === "/api/model-catalog") {
      only([]);
      return ok(modelArray ? [model] : { models: [model] });
    }
    if (url.pathname === "/api/connectors") {
      only(["cursor"]);
      return ok(query.cursor === undefined
        ? { items: [toolkit("other-toolkit")], nextCursor: "next-toolkit-page" }
        : { items: [toolkit("toolkit-result-collision", toolkitStatus)], nextCursor: null });
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
  return { target, agents, requests, setActionSelectable: (value: boolean) => { actionSelectable = value; },
    setActionStatus: (value: number) => { actionStatus = value; }, setModelArray: (value: boolean) => { modelArray = value; },
    setToolkitStatus: (value: string) => { toolkitStatus = value; } };
}

describe("target adapter against current read-only SP public wire fixtures", () => {
  it("uses strict Component pagination, individual Action detail, a true model array and cursor-based Toolkits", async () => {
    const f = fixture();
    const source: SourceAgent = { id: agentId, name: "Imported", slug: "original", description: null, revision: 1, setting: {
      ...canonicalSourceSettingFixture(),
      skillIds: [], connectorIds: ["connector-selected"], extensionIds: ["extension-selected"], actionIds: ["action-selected"],
      model: model.providerModel, presetId: model.id,
      mcpServers: [{ serverId: "managed" }, { serverId: "toolkit-result-collision", kind: "connector_toolkit" }],
    } };
    const prepared = await f.agents.prepareImport(source, "execution", evidence);
    expect(prepared.config.setting).toEqual(source.setting);
    const componentQueries = f.requests.filter((request) => new URL(request.url).pathname === "/api/components").map((request) => new URL(request.url).searchParams);
    expect(componentQueries.map((query) => [query.get("kind"), query.get("page")])).toEqual([["connector", "1"], ["connector", "2"], ["extension", "1"]]);
    expect(componentQueries.every((query) => !query.has("view"))).toBe(true);
    expect(f.requests.filter((request) => new URL(request.url).pathname === "/api/connectors").map((request) => new URL(request.url).search))
      .toEqual(["", "?cursor=next-toolkit-page"]);
    expect(f.requests.filter((request) => new URL(request.url).pathname === "/api/mcp-servers")).toHaveLength(2);
    expect(f.requests.every((request) => (request.method === "GET" || new URL(request.url).pathname === "/api/agent-config-imports/dependencies")
      && request.headers.get("Authorization") === "Bearer fixed-target-session")).toBe(true);
    expect(prepared.dependencies).toEqual(evidence);
  });

  it("preserves Toolkit selections rather than requiring them to exist as managed MCP Servers or provisioning connections", async () => {
    const f = fixture();
    await expect(f.target.validateSelections({ mcpServers: [{ serverId: "toolkit-result-collision", kind: "connector_toolkit" }] })).resolves.toBeUndefined();
    expect(f.requests.every((request) => new URL(request.url).pathname === "/api/connectors")).toBe(true);
    f.setToolkitStatus("configuration_required");
    await expect(f.target.validateSelections({ mcpServers: [{ serverId: "toolkit-result-collision", kind: "connector_toolkit" }] })).rejects.toBeInstanceOf(ImportConflictError);
  });

  it("uses public Action selectable facts and treats missing or disabled selections as conflicts, not empty catalogs", async () => {
    const f = fixture();
    f.setActionSelectable(false);
    await expect(f.target.validateSelections({ actionIds: ["action-selected"] }, [evidence[0]!])).rejects.toBeInstanceOf(ImportConflictError);
    f.setActionStatus(404);
    await expect(f.target.validateSelections({ actionIds: ["action-selected"] }, [evidence[0]!])).rejects.toBeInstanceOf(ImportConflictError);
    f.setActionStatus(401);
    await expect(f.target.validateSelections({ actionIds: ["action-selected"] }, [evidence[0]!])).rejects.toBeInstanceOf(ImportDependencyError);
  });

  it("does not accept a fabricated {models:[]} envelope in place of the public model array", async () => {
    const f = fixture();
    f.setModelArray(false);
    await expect(f.target.validateSelections({ model: model.providerModel })).rejects.toBeInstanceOf(ImportDependencyError);
  });

  it("keeps selected Skill queries distinct from Component queries and reads every public Skill file", async () => {
    const f = fixture();
    await expect(f.target.skill("platform-stable-string")).resolves.toMatchObject({
      id: "platform-stable-string", origin: "marketplace", files: [{ path: "SKILL.md" }, { path: "scripts/运行.py" }],
    });
  });
});
