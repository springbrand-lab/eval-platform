import { describe, expect, it, vi } from "vitest";
import { createAgentConfigService } from "../agent-configs.js";
import type { AgentPurposeInput, AgentPurposeStore } from "../db/agent-purposes.js";
import type { ResourceSourceStore } from "../db/agent-import-sources.js";
import { AgentConfigPurposeUnavailableError } from "../db/errors.js";
import type { ApiRuntime, OwnerServices } from "../lib/types.js";
import type { EvalSpClient } from "../sp/client.js";
import { EvalSpApiError } from "../sp/http.js";
import { jsonRequest, requestApp, WEB_ORIGIN } from "../test-support.js";

const owner = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const nativeId = "33333333-3333-4333-8333-333333333333";
const config = { id, user_id: owner, slug: `import-${id}`, name: "Agent", setting: { mcpServers: [] } };
type State = "confirmed" | "unknown" | "native" | "finalized";

function fixture(initial: State = "confirmed") {
  let state = initial;
  const native = { ...config, id: nativeId, slug: "ordinary", name: "Native" };
  const sp = {
    getAgentConfig: vi.fn(async () => config), listAgentConfigs: vi.fn(async () => [config]),
    listMcpServers: vi.fn(async () => []), createAgentConfig: vi.fn(async () => native),
    createAgentConfigOutcome: vi.fn(async () => ({ config: native, created: true })),
    updateAgentConfig: vi.fn(async (_token: string, _id: string, body: unknown) => ({ ...config, ...body as object })),
    deleteAgentConfig: vi.fn(async () => {}),
  };
  const record = (userAgentId: string) => ({ userAgentId, purpose: "execution" as const, evaluationMcpServerId: null });
  const purposes = {
    get: vi.fn(async (userAgentId: string) => record(userAgentId)),
    list: vi.fn(async (ids: readonly string[]) => ids.map(record)),
    upsert: vi.fn(async (input: AgentPurposeInput) => input), ensure: vi.fn(async (input: AgentPurposeInput) => input),
    remove: vi.fn(async () => {}),
  } satisfies AgentPurposeStore;
  const sources = {
    get: vi.fn(async () => null), recordNative: vi.fn(async () => {}),
    // The store owns proof validation. Unknown intents and native proof do not enter this set.
    pendingAgentIds: vi.fn(async (ids: readonly string[]) => new Set(state === "confirmed" ? ids.filter((value) => value === id) : [])),
  } satisfies ResourceSourceStore;
  const service = createAgentConfigService({ ownerUserId: owner, sessionToken: "fixed-session", sp: sp as unknown as EvalSpClient,
    purposes, sources, projects: { frozenAgentConfigIds: async () => new Set<string>() } });
  const invoke = {
    get: () => service.get(id), update: () => service.update(id, { name: "Edited" }),
    remove: () => service.remove(id), freeze: () => service.freeze(id, "execution"),
  };
  const runtime = { webOrigin: WEB_ORIGIN,
    serviceAccount: { user: { id: owner, role: "user" }, email: "service@test", sessionToken: "fixed-session" },
    ownerServices: () => ({ services: { agentConfigs: service } as unknown as OwnerServices, release: () => {} }),
  } as unknown as ApiRuntime;
  return { service, sp, sources, purposes, invoke, request: requestApp(runtime), setState: (value: State) => { state = value; } };
}

describe("confirmed pending Agent access fence", () => {
  it.each(["get", "update", "remove", "freeze"] as const)("rejects %s before any target read or write", async (operation) => {
    const f = fixture();
    await expect(f.invoke[operation]()).rejects.toBeInstanceOf(AgentConfigPurposeUnavailableError);
    for (const method of Object.values(f.sp)) expect(method).not.toHaveBeenCalled();
    expect(f.purposes.upsert).not.toHaveBeenCalled();
  });

  it("does not infer current existence from a confirmed historical receipt", async () => {
    const f = fixture();
    f.sp.getAgentConfig.mockRejectedValue(new EvalSpApiError(404, null));
    await expect(f.service.get(id)).rejects.toBeInstanceOf(AgentConfigPurposeUnavailableError);
    expect(f.sp.getAgentConfig).not.toHaveBeenCalled();
  });

  it.each(["GET", "PATCH", "DELETE"] as const)("retains the existing HTTP error envelope for pending %s", async (method) => {
    const f = fixture();
    const response = await f.request(`/api/agent-configs/${id}`,
      method === "GET" ? undefined : jsonRequest(method, method === "PATCH" ? { name: "Edited" } : undefined));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "AGENT_CONFIG_PURPOSE_UNAVAILABLE",
      errMsg: expect.any(String), requestId: expect.any(String) });
    for (const call of Object.values(f.sp)) expect(call).not.toHaveBeenCalled();
  });

  it.each(["unknown", "native"] as const)("does not hide, block or add source fields for %s provenance", async (state) => {
    const f = fixture(state);
    await expect(f.service.list()).resolves.toEqual([config]);
    await expect(f.invoke.get()).resolves.toEqual(config);
    await expect(f.invoke.update()).resolves.toMatchObject({ id, name: "Edited" });
    await expect(f.invoke.freeze()).resolves.toMatchObject({ userAgentId: nativeId });
    await expect(f.invoke.remove()).resolves.toBeUndefined();
    expect(f.sp.deleteAgentConfig).toHaveBeenCalledWith("fixed-session", id);
  });

  it("restores ordinary access after metadata finalization clears the pending fact", async () => {
    const f = fixture();
    await expect(f.service.list()).resolves.toEqual([]);
    await expect(f.invoke.get()).rejects.toBeInstanceOf(AgentConfigPurposeUnavailableError);
    f.setState("finalized");
    await expect(f.service.list()).resolves.toEqual([config]);
    await expect(f.invoke.get()).resolves.toEqual(config);
    await expect(f.invoke.update()).resolves.toMatchObject({ name: "Edited" });
    await expect(f.invoke.freeze()).resolves.toMatchObject({ userAgentId: nativeId });
    await expect(f.invoke.remove()).resolves.toBeUndefined();
  });

  it("does not run the pending import fence on ordinary native create or its affirmative insertion header", async () => {
    const f = fixture();
    await expect(f.service.create({ slug: "ordinary", name: "Native", purpose: "execution", setting: { mcpServers: [] } }))
      .resolves.toMatchObject({ id: nativeId });
    expect(f.sources.pendingAgentIds).not.toHaveBeenCalled();
    expect(f.sources.recordNative).toHaveBeenCalledExactlyOnceWith(nativeId);
    expect(f.sp.createAgentConfigOutcome).toHaveBeenCalledExactlyOnceWith("fixed-session",
      { slug: "ordinary", name: "Native", setting: { mcpServers: [] } });
  });
});
