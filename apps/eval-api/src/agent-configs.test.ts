import { describe, expect, it, vi } from "vitest";
import { createAgentConfigService } from "./agent-configs.js";
import type { AgentPurposeRecord, AgentPurposeStore } from "./db/agent-purposes.js";
import { AgentConfigFrozenError } from "./db/errors.js";
import type { EvalSpAgentConfig, EvalSpClient } from "./sp/client.js";
import { EvalSpApiError, EvalSpTransportError } from "./sp/http.js";

const owner = "owner";

function config(id: string, setting: Record<string, unknown>): EvalSpAgentConfig {
  return { id, user_id: owner, name: id, slug: id, setting };
}

function purposes(): AgentPurposeStore {
  const values = new Map<string, AgentPurposeRecord>();
  return {
    async list(ids) { return ids.flatMap((id) => values.get(id) ?? []); },
    async get(id) { return values.get(id) ?? null; },
    async ensure(input) {
      const current = values.get(input.userAgentId);
      if (current) return current;
      const created = { ...input } satisfies AgentPurposeRecord;
      values.set(input.userAgentId, created);
      return created;
    },
    async upsert(input) {
      const created = { ...input } satisfies AgentPurposeRecord;
      values.set(input.userAgentId, created);
      return created;
    },
    async remove(id) { values.delete(id); },
  };
}

function service(configs: readonly EvalSpAgentConfig[], mcpServers: readonly {
  id: string; source: string; status: string; url: string | null; authType: string | null;
}[], frozenIds: readonly string[] = []) {
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
    projects: { frozenAgentConfigIds: vi.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => frozenIds.includes(id)))) },
    purposes: purposeStore,
  }), { sp, purposeStore });
}

const resultMcp = { id: "result-mcp", source: "user", status: "active", url: "https://eval.example/mcp/evaluation-results", authType: "bearer" };
const otherMcp = { id: "other-mcp", source: "user", status: "active", url: "https://example.test/mcp/other", authType: "bearer" };
const toolkit = { serverId: "google-calendar", kind: "connector_toolkit" };

describe("Agent Config new selections", () => {
  it("refuses an archived source after deletion even when GET retains its body", async () => {
    const source = config("archived", { mcpServers: [] });
    const agents = service([source], []);
    agents.sp.deleteAgentConfig.mockImplementationOnce(async () => {
      agents.sp.listAgentConfigs.mockResolvedValue([]);
    });

    await agents.remove(source.id);
    expect(agents.sp.deleteAgentConfig).toHaveBeenCalledWith("session", source.id);
    await expect(agents.list()).resolves.toEqual([]);
    await expect(agents.listAgents()).resolves.toEqual([]);
    await expect(agents.get(source.id)).resolves.toEqual(source);

    const frozen = agents.freeze(source.id, "execution");
    await expect(frozen).rejects.toBeInstanceOf(EvalSpApiError);
    await expect(frozen).rejects.toMatchObject({ status: 404 });
    expect(agents.sp.createAgentConfig).not.toHaveBeenCalled();
    expect(agents.sp.listMcpServers).not.toHaveBeenCalled();
    await expect(agents.purposeStore.get(source.id)).resolves.toBeNull();
  });

  it("freezes an active owned source using the full GET body", async () => {
    const source = config("active", { model: "default", mcpServers: [] });
    const agents = service([source], []);
    agents.sp.listAgentConfigs.mockResolvedValue([{ id: source.id, user_id: owner, name: source.name }]);

    await expect(agents.freeze(source.id, "execution")).resolves.toEqual({
      userAgentId: "created",
      snapshot: { sourceUserAgentId: source.id, name: source.name, body: source },
    });
    expect(agents.sp.listAgentConfigs).toHaveBeenCalledWith("session");
    expect(agents.sp.createAgentConfig).toHaveBeenCalledExactlyOnceWith("session", {
      slug: expect.stringMatching(/^eval-frozen-/), name: "active (frozen)", description: null, setting: source.setting,
    });
  });

  it("keeps recorded and reserved-slug copies out of lists and new selections but readable by ID", async () => {
    const active = config("active", { mcpServers: [] });
    const recorded = config("recorded-copy", { mcpServers: [] });
    const orphan = { ...config("orphan", { mcpServers: [] }), slug: " Eval-Frozen-orphan " };
    const agents = service([active, recorded, orphan], [], [recorded.id]);

    await expect(agents.list()).resolves.toEqual([active]);
    await expect(agents.listAgents("subject", "execution")).resolves.toEqual([
      { agentConfig: { ownerUserId: owner, userAgentId: active.id }, name: active.name, role: "subject", purpose: "execution" },
    ]);
    for (const copy of [recorded, orphan]) {
      await expect(agents.freeze(copy.id, "execution")).rejects.toBeInstanceOf(AgentConfigFrozenError);
      await expect(agents.get(copy.id)).resolves.toEqual(copy);
    }
    expect(agents.sp.createAgentConfig).not.toHaveBeenCalled();
  });

  it("does not select a source listed under another owner", async () => {
    const source = config("foreign", { mcpServers: [] });
    const agents = service([source], []);
    agents.sp.listAgentConfigs.mockResolvedValue([{ ...source, user_id: "another-owner" }]);

    await expect(agents.freeze(source.id, "execution")).rejects.toMatchObject({ name: "EvalSpApiError", status: 404 });
    expect(agents.sp.createAgentConfig).not.toHaveBeenCalled();
  });

  it.each([
    new EvalSpApiError(503, null),
    new EvalSpTransportError(new Error("offline")),
  ])("preserves an active-list dependency failure without creating a copy (%s)", async (error) => {
    const agents = service([config("active", { mcpServers: [] })], []);
    agents.sp.listAgentConfigs.mockRejectedValueOnce(error);

    await expect(agents.freeze("active", "execution")).rejects.toBe(error);
    expect(agents.sp.createAgentConfig).not.toHaveBeenCalled();
  });

  it("does not require active-list membership for retained GETs or updates delegated to SP", async () => {
    const source = config("retained", { mcpServers: [] });
    const agents = service([source], []);
    agents.sp.listAgentConfigs.mockResolvedValue([]);

    await expect(agents.get(source.id)).resolves.toEqual(source);
    await expect(agents.update(source.id, { name: "renamed" })).resolves.toMatchObject({ id: source.id, name: "renamed" });
    expect(agents.sp.updateAgentConfig).toHaveBeenCalledWith("session", source.id, { name: "renamed" });
    expect(agents.sp.listAgentConfigs).not.toHaveBeenCalled();
  });
});

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

  it("normalizes the result MCP to match the requested purpose on create", async () => {
    const agents = service([], [resultMcp]);
    await agents.create({ name: "Executor", purpose: "execution", setting: { mcpServers: [{ serverId: resultMcp.id }] } });
    expect(agents.sp.createAgentConfig).toHaveBeenCalledWith("session", {
      name: "Executor", setting: { mcpServers: [] },
    });
  });

  it("preserves Connector Toolkits when creating an Execution Agent", async () => {
    const agents = service([], []);
    const setting = { mcpServers: [toolkit] };
    await expect(agents.create({ name: "Executor", purpose: "execution", setting })).resolves.toMatchObject({ id: "created" });
    expect(agents.sp.createAgentConfig).toHaveBeenCalledWith("session", { name: "Executor", setting });
  });

  it("preserves Connector Toolkits and managed MCPs when creating an Evaluation Agent", async () => {
    const agents = service([], [resultMcp, otherMcp]);
    await expect(agents.create({
      name: "Evaluator", purpose: "evaluation", setting: { mcpServers: [toolkit, { serverId: otherMcp.id }] },
    })).resolves.toMatchObject({ id: "created" });
    expect(agents.sp.createAgentConfig).toHaveBeenCalledWith("session", {
      name: "Evaluator", setting: { mcpServers: [toolkit, { serverId: otherMcp.id }, { serverId: resultMcp.id }] },
    });
    await expect(agents.purposeStore.get("created")).resolves.toMatchObject({
      purpose: "evaluation", evaluationMcpServerId: resultMcp.id,
    });
  });

  it("reconciles purpose independently of Connector Toolkit selections", async () => {
    const agents = service([
      config("executor", { mcpServers: [toolkit] }),
      config("evaluator", { mcpServers: [toolkit, { serverId: resultMcp.id }] }),
    ], [resultMcp]);
    await expect(agents.listAgents("subject", "execution")).resolves.toMatchObject([{ name: "executor", purpose: "execution" }]);
    await expect(agents.listAgents("evaluator", "evaluation")).resolves.toMatchObject([{ name: "evaluator", purpose: "evaluation" }]);
  });

  it("updates an Agent with Connector Toolkits and no purpose record", async () => {
    const agents = service([config("executor", { mcpServers: [toolkit] })], []);
    await expect(agents.update("executor", { name: "renamed" })).resolves.toMatchObject({ name: "renamed" });
    expect(agents.sp.updateAgentConfig).toHaveBeenCalledWith("session", "executor", { name: "renamed" });
    await expect(agents.purposeStore.get("executor")).resolves.toMatchObject({ purpose: "execution" });
  });

  it("freezes an Agent containing Connector Toolkits without changing its selections", async () => {
    const setting = { mcpServers: [toolkit] };
    const agents = service([config("executor", setting)], []);
    await expect(agents.freeze("executor", "execution")).resolves.toMatchObject({
      snapshot: { sourceUserAgentId: "executor", body: { setting } },
    });
    expect(agents.sp.createAgentConfig).toHaveBeenCalledWith("session", expect.objectContaining({ setting }));
  });

  it.each(["missing", "disabled"] as const)("still rejects a %s managed MCP alongside Connector Toolkits", async (availability) => {
    const agents = service([], availability === "disabled" ? [{ ...otherMcp, status: "disabled" }] : []);
    await expect(agents.create({
      name: "Executor", purpose: "execution", setting: { mcpServers: [toolkit, { serverId: otherMcp.id }] },
    })).rejects.toMatchObject({ name: "AgentConfigPurposeUnavailableError", userAgentId: "new" });
    expect(agents.sp.createAgentConfig).not.toHaveBeenCalled();
    await expect(agents.purposeStore.get("created")).resolves.toBeNull();
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

  it("switches purpose and synchronizes the result MCP binding", async () => {
    const executor = service([config("executor", { mcpServers: [] })], [resultMcp]);
    await executor.purposeStore.upsert({ userAgentId: "executor", purpose: "execution", evaluationMcpServerId: null });
    await executor.update("executor", { purpose: "evaluation", name: "Evaluator" });
    expect(executor.sp.updateAgentConfig).toHaveBeenLastCalledWith("session", "executor", {
      name: "Evaluator", setting: { mcpServers: [{ serverId: resultMcp.id }] },
    });
    await expect(executor.purposeStore.get("executor")).resolves.toEqual({
      userAgentId: "executor", purpose: "evaluation", evaluationMcpServerId: resultMcp.id,
    });

    const evaluator = service([config("evaluator", { mcpServers: [{ serverId: resultMcp.id }] })], [resultMcp]);
    await evaluator.purposeStore.upsert({ userAgentId: "evaluator", purpose: "evaluation", evaluationMcpServerId: resultMcp.id });
    await evaluator.update("evaluator", { purpose: "execution" });
    expect(evaluator.sp.updateAgentConfig).toHaveBeenLastCalledWith("session", "evaluator", {
      setting: { mcpServers: [] },
    });
    await expect(evaluator.purposeStore.get("evaluator")).resolves.toEqual({
      userAgentId: "evaluator", purpose: "execution", evaluationMcpServerId: null,
    });
  });

  it("can switch an Evaluation Agent back to execution without reading the MCP catalog", async () => {
    const evaluator = service([config("evaluator", { mcpServers: [{ serverId: resultMcp.id }] })], [resultMcp]);
    await evaluator.purposeStore.upsert({ userAgentId: "evaluator", purpose: "evaluation", evaluationMcpServerId: resultMcp.id });
    evaluator.sp.listMcpServers.mockRejectedValue(new Error("catalog offline"));
    await expect(evaluator.update("evaluator", { purpose: "execution" })).resolves.toMatchObject({ id: "evaluator" });
    expect(evaluator.sp.updateAgentConfig).toHaveBeenLastCalledWith("session", "evaluator", { setting: { mcpServers: [] } });
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
    await expect(agents.update("evaluator", { setting: { mcpServers: [] } })).rejects.toMatchObject({ name: "AgentConfigPurposeUnavailableError" });
  });

  it("repairs a missing result binding when an Evaluation Agent is saved", async () => {
    const agents = service([config("evaluator", { mcpServers: [] })], [resultMcp]);
    await agents.purposeStore.upsert({ userAgentId: "evaluator", purpose: "evaluation", evaluationMcpServerId: resultMcp.id });
    await expect(agents.update("evaluator", { purpose: "evaluation", name: "renamed", setting: { mcpServers: [] } })).resolves.toMatchObject({ name: "renamed" });
    expect(agents.sp.updateAgentConfig).toHaveBeenLastCalledWith("session", "evaluator", {
      name: "renamed", setting: { mcpServers: [{ serverId: resultMcp.id }] },
    });
  });

  it("replaces a stale result MCP instead of accumulating a second binding", async () => {
    const agents = service([config("evaluator", { mcpServers: [{ serverId: "old-result-mcp" }] })], [resultMcp]);
    await agents.purposeStore.upsert({ userAgentId: "evaluator", purpose: "evaluation", evaluationMcpServerId: "old-result-mcp" });
    await agents.update("evaluator", { purpose: "evaluation", setting: { mcpServers: [{ serverId: "old-result-mcp" }] } });
    expect(agents.sp.updateAgentConfig).toHaveBeenLastCalledWith("session", "evaluator", {
      setting: { mcpServers: [{ serverId: resultMcp.id }] },
    });
  });

  it("rejects selecting an Agent for the wrong Project role", async () => {
    const agents = service([config("executor", { mcpServers: [] })], [resultMcp]);
    await expect(agents.freeze("executor", "evaluation")).rejects.toMatchObject({
      name: "AgentConfigPurposeMismatchError", expected: "evaluation", actual: "execution",
    });
  });
});

describe("management Agent creation replay safety", () => {
  const slug = "eval-mgmt-operation-digest";
  const existing = { ...config("agent", { mcpServers: [] }), slug, name: "Executor", description: null };
  const body = { slug, name: "Executor", description: null, purpose: "execution", setting: { mcpServers: [] } };

  it("returns only an active owned Agent whose fresh body and recorded purpose match", async () => {
    const agents = service([existing], []);
    await agents.purposeStore.upsert({ userAgentId: existing.id, purpose: "execution", evaluationMcpServerId: null });
    const receipt = vi.fn(async () => ({ config: existing, created: false }));
    Object.assign(agents.sp, { createAgentConfigOutcome: receipt });

    await expect(agents.create(body, { verifyReplay: true })).resolves.toEqual(existing);
    expect(receipt).toHaveBeenCalledWith("session", { slug, name: "Executor", description: null, setting: { mcpServers: [] } });
    expect(agents.sp.deleteAgentConfig).not.toHaveBeenCalled();
    expect(agents.sp.createAgentConfig).not.toHaveBeenCalled();
  });

  it("checks the result-submission MCP binding on an Evaluation Agent replay without changing it", async () => {
    const evaluator = { ...existing, setting: { mcpServers: [{ serverId: resultMcp.id }] } };
    const agents = service([evaluator], [resultMcp]);
    await agents.purposeStore.upsert({ userAgentId: evaluator.id, purpose: "evaluation",
      evaluationMcpServerId: resultMcp.id });
    Object.assign(agents.sp, { createAgentConfigOutcome: vi.fn(async () => ({ config: evaluator, created: false })) });
    await expect(agents.create({ ...body, purpose: "evaluation" }, { verifyReplay: true })).resolves.toEqual(evaluator);
    expect(agents.sp.deleteAgentConfig).not.toHaveBeenCalled();
    await agents.purposeStore.upsert({ userAgentId: evaluator.id, purpose: "evaluation",
      evaluationMcpServerId: "other-result-server" });
    await expect(agents.create({ ...body, purpose: "evaluation" }, { verifyReplay: true }))
      .rejects.toMatchObject({ code: "EVAL_SP_CONFLICT" });
    expect(agents.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it.each(["missing-purpose", "different-purpose", "changed-body", "archived", "other-owner", "system-default"] as const)(
    "refuses %s without rewriting the existing Agent or deleting it", async (failure) => {
      const agents = service([existing], []);
      if (failure !== "missing-purpose") {
        await agents.purposeStore.upsert({ userAgentId: existing.id,
          purpose: failure === "different-purpose" ? "evaluation" : "execution", evaluationMcpServerId: null });
      }
      Object.assign(agents.sp, { createAgentConfigOutcome: vi.fn(async () => ({ config: existing, created: false })) });
      if (failure === "changed-body") agents.sp.getAgentConfig.mockResolvedValue({ ...existing, setting: { mcpServers: [], systemPrompt: "changed" } });
      if (failure === "archived") agents.sp.listAgentConfigs.mockResolvedValue([]);
      if (failure === "other-owner") agents.sp.getAgentConfig.mockResolvedValue({ ...existing, user_id: "foreign" });
      if (failure === "system-default") agents.sp.getAgentConfig.mockResolvedValue({ ...existing, is_default: true });

      await expect(agents.create(body, { verifyReplay: true })).rejects.toMatchObject({ code: "EVAL_SP_CONFLICT" });
      expect(agents.sp.deleteAgentConfig).not.toHaveBeenCalled();
      expect(agents.sp.updateAgentConfig).not.toHaveBeenCalled();
      if (failure === "missing-purpose") expect(await agents.purposeStore.get(existing.id)).toBeNull();
      else expect(await agents.purposeStore.get(existing.id)).toMatchObject({
        purpose: failure === "different-purpose" ? "evaluation" : "execution",
      });
    },
  );

  it("refuses an unknown creation result instead of writing a purpose or deleting an Agent", async () => {
    const agents = service([], []);
    Object.assign(agents.sp, { createAgentConfigOutcome: vi.fn(async () => ({ config: existing, created: null })) });
    await expect(agents.create(body, { verifyReplay: true })).rejects.toMatchObject({ code: "EVAL_SP_UNAVAILABLE" });
    expect(await agents.purposeStore.get(existing.id)).toBeNull();
    expect(agents.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it("never compensates an unproven legacy SP response on ordinary create failure", async () => {
    const agents = service([], []);
    vi.spyOn(agents.purposeStore, "upsert").mockRejectedValue(new Error("purpose DB failure"));
    await expect(agents.create(body)).rejects.toThrow("purpose DB failure");
    expect(agents.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });
});
