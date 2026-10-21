import { describe, expect, it, vi } from "vitest";
import { createAgentConfigService } from "../agent-configs.js";
import type { AgentPurposeStore } from "../db/agent-purposes.js";
import type { EvalSpClient } from "../sp/client.js";
import type { AgentImportTarget } from "./target.js";
import type { SourceAgent } from "./model.js";
import { canonicalSourceSettingFixture } from "./public-wire.test-support.js";

const id = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const receipt = { id: "33333333-3333-4333-8333-333333333333", resourceKind: "agent" as const, resourceId: id,
  importKey: "key", fingerprint: "server-payload", createdAt: "2026-10-21T00:00:00Z" };
const source: SourceAgent = { id, name: "Original", description: null, slug: "original", revision: 3,
  setting: { ...canonicalSourceSettingFixture(), skillIds: ["platform-string"], mcpServers: [{ serverId: "toolkit-id", kind: "connector_toolkit" }] } };
function setup() {
  const sp = {
    listMcpServers: vi.fn(async () => []), deleteAgentConfig: vi.fn(), createAgentConfig: vi.fn(),
    listAgentConfigs: vi.fn(async () => [{ id: "old-native", user_id: owner, name: "Native" }]),
  };
  const purpose = { upsert: vi.fn(async () => { throw new Error("local purpose DB offline"); }) };
  const imports = {
    validateSelections: vi.fn(async () => {}),
    agent: vi.fn<AgentImportTarget["agent"]>(async () => ({ ...source, user_id: owner, slug: `import-${id}` })),
    listAgents: vi.fn<AgentImportTarget["listAgents"]>(async () => [{ id, user_id: owner, name: source.name }]),
    importAgent: vi.fn(async (prepared: { config: Record<string, unknown> }) =>
      ({ receipt, replayed: false, resource: { ...prepared.config, user_id: owner } })),
  };
  const sources = { get: vi.fn(async () => null), recordNative: vi.fn(), pendingAgentIds: vi.fn(async () => new Set<string>()) };
  const service = createAgentConfigService({
    ownerUserId: owner, sessionToken: "session", sp: sp as unknown as EvalSpClient,
    purposes: purpose as unknown as AgentPurposeStore, projects: { frozenAgentConfigIds: async () => new Set<string>() },
    imports: imports as unknown as AgentImportTarget, sources,
  });
  return { sp, purpose, imports, sources, service };
}

describe("Agent Config owned create-only import flow", () => {
  it("keeps IDs and Toolkit selections, records a receipt before purpose, and never compensates by DELETE", async () => {
    const { sp, imports, service } = setup();
    const prepared = await service.prepareImport(source, "execution");
    expect(prepared.config).toEqual({ id, name: source.name, slug: `import-${id}`, description: null, setting: source.setting });
    const confirmed = vi.fn(async () => {});
    await expect(service.import(prepared, "key", confirmed)).rejects.toThrow("purpose DB offline");
    expect(confirmed).toHaveBeenCalledWith(expect.objectContaining({ receipt }));
    expect(imports.importAgent).toHaveBeenCalledWith(prepared, "key");
    expect(sp.deleteAgentConfig).not.toHaveBeenCalled();
    expect(sp.createAgentConfig).not.toHaveBeenCalled();
  });

  it("uses the same frozen/default/purpose protection for imports", async () => {
    const { imports, service } = setup();
    await expect(service.prepareImport({ ...source, slug: "eval-frozen-copy" }, "execution")).rejects.toMatchObject({ name: "AgentConfigFrozenError" });
    await expect(service.prepareImport({ ...source, slug: "default" }, "execution")).rejects.toThrow();
    await expect(service.prepareImport(source, "evaluation")).rejects.toMatchObject({ name: "AgentConfigPurposeUnavailableError" });
    expect(imports.importAgent).not.toHaveBeenCalled();
  });

  for (const delivery of ["post replay", "cached"] as const) {
    it.each(["missing", "changed", "archived"] as const)(`freshly verifies ${delivery} before metadata when current Agent is %s`, async (change) => {
      const { sp, imports, purpose, service } = setup();
      const prepared = await service.prepareImport(source, "execution");
      const historical = { receipt, replayed: true, resource: { ...prepared.config, user_id: owner } };
      imports.importAgent.mockResolvedValueOnce(historical);
      if (change === "missing") imports.agent.mockResolvedValueOnce(null);
      if (change === "changed") imports.agent.mockResolvedValueOnce({ ...historical.resource, name: "External edit" });
      if (change === "archived") imports.listAgents.mockResolvedValueOnce([]);
      const confirmed = vi.fn(async () => {});
      await expect(service.import(prepared, "key", confirmed, delivery === "cached" ? historical : undefined))
        .rejects.toMatchObject({ code: "EVAL_SP_CONFLICT" });
      expect(imports.agent).toHaveBeenCalledExactlyOnceWith(id);
      expect(purpose.upsert).not.toHaveBeenCalled();
      expect(confirmed).not.toHaveBeenCalled();
      expect(sp.deleteAgentConfig).not.toHaveBeenCalled();
      expect(sp.createAgentConfig).not.toHaveBeenCalled();
    });
  }

  it("lets the importer finish a confirmed pending Agent without routing its fresh read through the ordinary access fence", async () => {
    const { imports, purpose, sources, service } = setup();
    const prepared = await service.prepareImport(source, "execution");
    const recovered = { receipt, replayed: true, resource: { ...prepared.config, user_id: owner } };
    purpose.upsert.mockResolvedValue({} as never);
    sources.pendingAgentIds.mockResolvedValue(new Set([id]));
    await expect(service.get(id)).rejects.toMatchObject({ name: "AgentConfigPurposeUnavailableError" });
    const confirmed = vi.fn(async () => {});
    await expect(service.import(prepared, "key", confirmed, recovered)).resolves.toEqual(recovered);
    expect(imports.agent).toHaveBeenCalledExactlyOnceWith(id);
    expect(imports.importAgent).not.toHaveBeenCalled();
    expect(purpose.upsert).toHaveBeenCalledExactlyOnceWith({ userAgentId: id, purpose: "execution", evaluationMcpServerId: null });
    expect(sources.recordNative).not.toHaveBeenCalled();
  });

  it("does not classify unknown intents as native provenance or suppress native Agents", async () => {
    const { service, sources } = setup();
    await expect(service.list()).resolves.toMatchObject([{ id: "old-native" }]);
    expect(sources.recordNative).not.toHaveBeenCalled();
  });

  it("keeps ordinary create separate from import permissions and leaves legacy outcomes unknown", async () => {
    const { sp, purpose, imports, sources, service } = setup();
    purpose.upsert.mockResolvedValue({} as never);
    sp.createAgentConfig.mockResolvedValue({ id, user_id: owner, name: "New" });
    await service.create({ slug: "new", name: "New", purpose: "execution", setting: { mcpServers: [] } });
    expect(sp.createAgentConfig).toHaveBeenCalledWith("session", { slug: "new", name: "New", setting: { mcpServers: [] } });
    expect(imports.importAgent).not.toHaveBeenCalled();
    expect(sources.recordNative).not.toHaveBeenCalled();
  });
});
