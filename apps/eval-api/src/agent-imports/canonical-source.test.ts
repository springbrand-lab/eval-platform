import { afterEach, describe, expect, it } from "vitest";
import { ImportConflictError } from "./errors.js";
import { digest, type SourceAgent } from "./model.js";
import { canonicalSourceSettingFixture } from "./public-wire.test-support.js";
import { agentId, otherAgentId, referenceId, snapshotFixture, workerFixture } from "./worker.test-support.js";

const fixtures: Awaited<ReturnType<typeof workerFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
async function fixture() {
  const snapshot = snapshotFixture();
  snapshot.agents[0]!.setting = { ...canonicalSourceSettingFixture(), skillIds: ["private-skill", "builtin-demo"],
    referenceFileIds: [referenceId] };
  snapshot.agents[1]!.setting = canonicalSourceSettingFixture();
  const f = await workerFixture(snapshot); fixtures.push(f);
  return { ...f, snapshot };
}
const resourcePosts = (f: Awaited<ReturnType<typeof fixture>>) => f.requests.filter((request) => request.method === "POST"
  && new URL(request.url).pathname !== "/api/agent-config-imports/dependencies");

describe("SP-owned canonical source setting consumed before prepared-plan freezing", () => {
  it("preserves the full current export wire with null preset/empty references through hashes and target receipt checks", async () => {
    const f = await fixture();
    // SP may store legal omissions, but its current public export fills defaults before sending this literal wire.
    // No SP private model or local copy of normalizeAgentConfig is involved here.
    const wire = { ...canonicalSourceSettingFixture(), skillIds: ["private-skill", "builtin-demo"],
      systemPrompt: "Keep the complete config — 运行", thinking: "medium", executionLevel: "safe",
      toolPolicy: { allow: ["workspace.read"], deny: ["workspace.delete"] },
      memoryDefaults: { enabled: false, memoryTokens: 1234, preferencesTokens: 321 }, sandbox: { enabled: true },
      subagentNames: ["custom"] };
    f.snapshot.agents[0]!.setting = wire;
    const original = structuredClone(wire);
    const task = await f.preview([agentId]);
    expect(task.view.agents[0]?.status).toBe("ready");
    const source = task.snapshot!.agents[0]!;
    const resource = task.plan!.resources.find((resource) => resource.kind === "agent")!;
    expect(source.setting).toEqual(original);
    expect(resource.source).toEqual(source);
    expect(resource.prepared!.config.setting).toEqual(original);
    expect(resource.sourceDigest).toBe(digest({ version: 1, source, dependencies: [] }));
    expect(resource.targetDigest).toBe(digest({ version: 1, prepared: resource.prepared }));
    const frozenPlan = structuredClone(task.plan);
    const sourceReads = f.requests.filter((request) => new URL(request.url).origin === "https://dev.test").length;
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(task.plan).toEqual(frozenPlan);
    expect(f.targetAgents.get(agentId)?.setting).toEqual(original);
    const post = resourcePosts(f).find((request) => new URL(request.url).pathname === "/api/user-agent-configs/imports")!;
    expect((await post.clone().json()).setting).toEqual(original);
    expect(f.requests.filter((request) => new URL(request.url).origin === "https://dev.test")).toHaveLength(sourceReads);
    expect(f.snapshot.agents[0]!.setting).toEqual(original);
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it.each(["presetId", "referenceFileIds", "connectorIds", "extensionIds"] as const)(
    "rejects noncanonical missing %s only for its Agent, before any of that root's target resource writes",
    async (field) => {
      const f = await fixture();
      const setting = { ...f.snapshot.agents[0]!.setting };
      delete setting[field];
      f.snapshot.agents[0]!.setting = setting;
      const original = structuredClone(f.snapshot);
      const task = await f.preview();
      expect(task.view.status).toBe("ready");
      expect(task.view.agents.map((agent) => agent.status)).toEqual(["conflict", "ready"]);
      expect(task.plan!.eligibleAgentIds).toEqual([otherAgentId]);
      expect(task.plan!.resources.some((resource) => resource.id === agentId)).toBe(false);
      await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
      expect([...f.targetAgents.keys()]).toEqual([otherAgentId]);
      expect(resourcePosts(f).map((request) => new URL(request.url).pathname)).toEqual(["/api/user-agent-configs/imports"]);
      expect(f.snapshot).toEqual(original); // never patch dev or silently fill missing defaults locally
      expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
    },
  );

  it.each([
    { presetId: 42 }, { referenceFileIds: null }, { connectorIds: null }, { extensionIds: null },
  ])("does not reinterpret invalid canonical fields as omitted defaults: %#", async (invalid) => {
    const f = await fixture();
    f.snapshot.agents[0]!.setting = { ...f.snapshot.agents[0]!.setting, ...invalid };
    const task = await f.preview();
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["conflict", "ready"]);
    expect(resourcePosts(f)).toEqual([]);
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect([...f.targetAgents.keys()]).toEqual([otherAgentId]);
  });

  it("also fails closed at the public Agent import preparation service, without target-only normalization", async () => {
    const f = await fixture();
    const source = { ...f.snapshot.agents[0]!, setting: { ...canonicalSourceSettingFixture() } } as SourceAgent;
    delete (source.setting as Record<string, unknown>).presetId;
    await expect(f.agents.prepareImport(source, "execution")).rejects.toBeInstanceOf(ImportConflictError);
    expect(resourcePosts(f)).toEqual([]);
  });
});
