import { describe, expect, it, vi } from "vitest";
import { createAgentConfigService } from "./agent-configs.js";
import type { AgentPurposeRecord, AgentPurposeStore } from "./db/agent-purposes.js";
import type { EvalSpAgentConfig, EvalSpClient } from "./sp/client.js";

const owner = "owner";

function config(id: string, setting: Record<string, unknown>): EvalSpAgentConfig {
  return { id, user_id: owner, name: id, slug: id, setting };
}

function purposes(): AgentPurposeStore {
  const values = new Map<string, AgentPurposeRecord>();
  return {
    async list(ids) { return ids.flatMap((id) => values.get(id) ?? []); },
    async get(id) { return values.get(id) ?? null; },
    async createIfAbsent(input) {
      const current = values.get(input.userAgentId);
      if (current) return current;
      const created = { ...input } satisfies AgentPurposeRecord;
      values.set(input.userAgentId, created);
      return created;
    },
    async remove(id) { values.delete(id); },
  };
}

function service(configs: readonly EvalSpAgentConfig[], mcpServers: readonly {
  id: string; source: string; status: string; url: string | null; authType: string | null;
}[]) {
  const sp = {
    listAgentConfigs: vi.fn(async () => configs),
    listMcpServers: vi.fn(async (_token: string, source: "platform" | "user" = "user") => mcpServers.filter((server) => server.source === source)),
    getAgentConfig: vi.fn(async (_token: string, id: string) => configs.find((item) => item.id === id)!),
    createAgentConfig: vi.fn(async (_token: string, input: unknown) => {
      const body = input as Record<string, unknown>;
      return { id: "created", user_id: owner, name: String(body.name ?? "created"), slug: "created", setting: body.setting };
    }),
    updateAgentConfig: vi.fn(async (_token: string, id: string, body: unknown) => ({ ...configs.find((item) => item.id === id)!, ...(body as object) })),
    deleteAgentConfig: vi.fn(async () => undefined),
  };
  const client = sp as unknown as EvalSpClient;
  const purposeStore = purposes();
  return Object.assign(createAgentConfigService({
    ownerUserId: owner,
    sessionToken: "session",
    sp: client,
    projects: { frozenAgentConfigIds: vi.fn(async () => new Set<string>()) },
    purposes: purposeStore,
  }), { sp, purposeStore });
}

const resultMcp = { id: "result-mcp", source: "user", status: "active", url: "https://eval.example/mcp/evaluation-results", authType: "bearer" };
const otherMcp = { id: "other-mcp", source: "user", status: "active", url: "https://example.test/mcp/other", authType: "bearer" };

describe("Agent purpose filtering", () => {
  it("persists the selected purpose without sending Eval metadata to SP", async () => {
    const agents = service([], [resultMcp]);
    await expect(agents.create({ name: "Evaluator", purpose: "evaluation", setting: { mcpServers: [{ serverId: resultMcp.id }] } })).resolves.toMatchObject({ id: "created" });
    expect(agents.sp.createAgentConfig).toHaveBeenCalledWith("session", {
      name: "Evaluator", setting: { mcpServers: [{ serverId: resultMcp.id }] },
    });
    await expect(agents.purposeStore.get("created")).resolves.toEqual({
      userAgentId: "created", purpose: "evaluation", evaluationMcpServerId: resultMcp.id,
    });
  });

  it("rejects a create request whose purpose disagrees with its MCP binding", async () => {
    const agents = service([], [resultMcp]);
    await expect(agents.create({ name: "Executor", purpose: "execution", setting: { mcpServers: [{ serverId: resultMcp.id }] } })).rejects.toMatchObject({
      name: "AgentConfigPurposeMismatchError", expected: "execution", actual: "evaluation",
    });
    expect(agents.sp.createAgentConfig).not.toHaveBeenCalled();
  });

  it("fails purpose reads when the selected result MCP is disabled or ambiguous", async () => {
    const disabled = service([config("stored", { mcpServers: [{ serverId: resultMcp.id }] })], [{ ...resultMcp, status: "disabled" }]);
    await expect(disabled.listAgents("evaluator", "evaluation")).rejects.toMatchObject({ name: "AgentConfigPurposeUnavailableError", userAgentId: "stored" });
    await expect(disabled.listAgents()).rejects.toMatchObject({ name: "AgentConfigPurposeUnavailableError" });
    const duplicate = service([config("stored", { mcpServers: [{ serverId: resultMcp.id }] })], [resultMcp, { ...resultMcp, id: "result-mcp-2" }]);
    await expect(duplicate.listAgents("evaluator", "evaluation")).rejects.toMatchObject({ name: "AgentConfigPurposeUnavailableError" });
  });

  it("does not expose an unknown purpose when the MCP catalog is unavailable", async () => {
    const offline = service([config("orphan", { mcpServers: [] })], []);
    offline.sp.listMcpServers.mockRejectedValueOnce(new Error("offline"));
    await expect(offline.listAgents()).rejects.toMatchObject({ name: "AgentConfigPurposeUnavailableError" });
  });

  it("classifies and filters configs from their selected evaluation result MCP", async () => {
    const agents = service([
      config("executor", { mcpServers: [{ serverId: "other-mcp" }] }),
      config("evaluator", { mcpServers: [{ serverId: resultMcp.id }] }),
      config("plain", { model: "default" }),
    ], [resultMcp, otherMcp]);

    await expect(agents.listAgents("subject", "execution")).resolves.toEqual([
      { agentConfig: { ownerUserId: owner, userAgentId: "executor" }, name: "executor", role: "subject", purpose: "execution" },
      { agentConfig: { ownerUserId: owner, userAgentId: "plain" }, name: "plain", role: "subject", purpose: "execution" },
    ]);
    await expect(agents.listAgents()).resolves.toHaveLength(6);
    await expect(agents.listAgents("subject")).resolves.toHaveLength(3);
    await expect(agents.listAgents("evaluator", "evaluation")).resolves.toMatchObject([{ name: "evaluator", role: "evaluator", purpose: "evaluation" }]);
  });

  it("uses the fixed path rather than a server name or description", async () => {
    const misleadingMcp = { ...resultMcp, name: "A custom name", url: "https://eval.example/tools/evaluation-results" };
    const agents = service([config("evaluator", { mcpServers: [{ serverId: "result-mcp" }] })], [misleadingMcp]);
    await expect(agents.listAgents("evaluator", "evaluation")).resolves.toEqual([]);
  });

  it("rejects an update that changes the purpose after creation", async () => {
    const agents = service([config("evaluator", { mcpServers: [{ serverId: resultMcp.id }] })], [resultMcp]);
    await expect(agents.update("evaluator", { setting: { mcpServers: [] } })).rejects.toMatchObject({
      name: "AgentConfigPurposeLockedError", userAgentId: "evaluator",
    });
    const executor = service([config("executor", { mcpServers: [] })], [resultMcp]);
    await expect(executor.update("executor", { setting: { mcpServers: [{ serverId: resultMcp.id }] } })).rejects.toMatchObject({
      name: "AgentConfigPurposeLockedError", userAgentId: "executor",
    });
  });

  it("keeps the persisted purpose after the external MCP catalog changes", async () => {
    const servers = [resultMcp];
    const agents = service([config("evaluator", { mcpServers: [{ serverId: resultMcp.id }] })], servers);
    await expect(agents.listAgents("evaluator", "evaluation")).resolves.toHaveLength(1);
    await expect(agents.update("evaluator", { purpose: "evaluation", name: "renamed" })).resolves.toMatchObject({ name: "renamed" });
    expect(agents.sp.updateAgentConfig).toHaveBeenLastCalledWith("session", "evaluator", { name: "renamed" });
    servers.splice(0);
    await expect(agents.listAgents("evaluator", "evaluation")).resolves.toHaveLength(1);
    await expect(agents.update("evaluator", { name: "renamed" })).resolves.toMatchObject({ name: "renamed" });
    await expect(agents.update("evaluator", { setting: { mcpServers: [] } })).rejects.toMatchObject({ name: "AgentConfigPurposeLockedError" });
  });

  it("rejects updates when an Evaluation Agent has lost its recorded result binding", async () => {
    const agents = service([config("evaluator", { mcpServers: [] })], [resultMcp]);
    await agents.purposeStore.createIfAbsent({ userAgentId: "evaluator", purpose: "evaluation", evaluationMcpServerId: resultMcp.id });
    await expect(agents.update("evaluator", { name: "renamed" })).rejects.toMatchObject({
      name: "AgentConfigPurposeLockedError", userAgentId: "evaluator",
    });
  });

  it("rejects selecting an Agent for the wrong Project role", async () => {
    const agents = service([config("executor", { mcpServers: [] })], [resultMcp]);
    await expect(agents.freeze("executor", "evaluation")).rejects.toMatchObject({
      name: "AgentConfigPurposeMismatchError", expected: "evaluation", actual: "execution",
    });
  });
});
