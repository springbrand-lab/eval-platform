import { afterEach, describe, expect, it } from "vitest";
import { ImportLeaseLostError, ImportOutcomeUnknownError, ImportTargetDisabledError } from "./errors.js";
import { IMPORT_LIMITS, resourceKey } from "./model.js";
import { agentId, otherAgentId, owner, referenceId, sourceUser, snapshotFixture, workerFixture } from "./worker.test-support.js";

const fixtures: Awaited<ReturnType<typeof workerFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
async function fixture(snapshot = snapshotFixture()) {
  const value = await workerFixture(snapshot); fixtures.push(value); return value;
}
const posts = (f: Awaited<ReturnType<typeof workerFixture>>, pathname: string) =>
  f.requests.filter((request) => request.method === "POST" && new URL(request.url).pathname === pathname);

describe("durable import worker through approved public HTTP seams", () => {
  it("classifies a real receipt HTTP conflict as terminal for that root, not outcome_unknown", async () => {
    const f = await fixture();
    const task = await f.preview();
    await f.store.apply(task.id, "apply");
    const key = task.plan!.resources.find((resource) => resource.kind === "agent" && resource.id === agentId)!.importKey;
    const fetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === `/api/agent-config-imports/receipts/${key}`) {
        return Response.json({ code: "AGENT_CONFIG_IMPORT_CONFLICT", errMsg: "current definition changed" }, { status: 409 });
      }
      return fetch(request);
    });
    await expect(f.worker.run(task.id)).resolves.toBeUndefined();
    expect(task.view.status).toBe("completed_with_errors");
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["conflict", "created"]);
    expect(f.intents.get(resourceKey("agent", agentId))?.status).toBe("conflict");
    expect(f.sources.has(resourceKey("agent", agentId))).toBe(false);
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(1);
    const count = f.requests.length;
    await f.worker.run(task.id);
    expect(f.requests).toHaveLength(count);
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it("keeps an existing imported Agent's receipt conflict local to that preview root", async () => {
    const f = await fixture();
    const first = await f.preview([agentId]);
    await f.store.apply(first.id, "apply"); await f.worker.run(first.id);
    const key = f.sources.get(resourceKey("agent", agentId))!.receipt!.importKey;
    const fetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === `/api/agent-config-imports/receipts/${key}`) {
        return Response.json({ code: "AGENT_CONFIG_IMPORT_CONFLICT", errMsg: "proof is no longer current" }, { status: 409 });
      }
      return fetch(request);
    });
    f.resetTask();
    const next = await f.preview();
    expect(next.view.status).toBe("ready");
    expect(next.view.agents.map((agent) => agent.status)).toEqual(["conflict", "ready"]);
    const before = posts(f, "/api/user-agent-configs/imports").length;
    await f.store.apply(next.id, "next-apply"); await f.worker.run(next.id);
    expect(next.view.status).toBe("completed_with_errors");
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(before + 1);
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it("performs no target write while disabled after enqueue, and resumes the same apply after capability is enabled", async () => {
    const f = await fixture();
    const task = await f.preview();
    await f.store.apply(task.id, "apply");
    f.setTargetEnabled(false);
    await expect(f.worker.run(task.id, { final: true })).rejects.toBeInstanceOf(ImportTargetDisabledError);
    expect(task.view.status).toBe("outcome_unknown");
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    f.setTargetEnabled(true);
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
  });
  it("prepares only the selected union, imports all Skill bytes and target attachments, dependencies before same-ID Agents", async () => {
    const f = await fixture();
    const task = await f.preview();
    expect(task.view.agents.map((item) => item.status)).toEqual(["ready", "ready"]);
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    expect(f.requests.some((request) => request.url.endsWith("/unused"))).toBe(false);
    await f.store.apply(task.id, "apply");
    expect(f.events.at(-1)).toBe("enqueue:apply");
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(task.view.summary).toEqual({ created: 2, skipped: 0, failed: 0, conflicts: 0 });
    expect(f.zipFiles).toEqual([["SKILL.md", "scripts/run.py"]]);
    expect([...f.targetAgents.keys()].sort()).toEqual([agentId, otherAgentId].sort());
    expect(f.targetAgents.get(agentId)?.setting).toMatchObject({ skillIds: ["private-skill", "builtin-demo"], referenceFileIds: [referenceId] });
    expect(f.targetReferences.get(referenceId)?.attachmentCdnUrl).toContain("https://eval.test/");
    expect(f.sources.get(resourceKey("skill", "builtin-demo"))?.origin).toBe("platform_catalog");
    expect(f.sources.get(resourceKey("skill", "private-skill"))).toMatchObject({ id: "private-skill", ownerUserId: owner, origin: "dev_import" });
    expect(f.sources.get(resourceKey("reference", referenceId))?.receipt?.resourceId).toBe(referenceId);
    expect(f.events.indexOf("intent:skill:private-skill")).toBeLessThan(f.events.indexOf("remote:/api/skills/imports"));
    expect(f.events.indexOf("remote:/api/user-references/imports")).toBeLessThan(f.events.indexOf("remote:/api/user-agent-configs/imports"));
    expect(posts(f, "/api/skills/imports")).toHaveLength(1); // platform string ID was verified, not uploaded
    expect(f.requests.filter((request) => new URL(request.url).origin === "https://dev.test").every((request) => request.method === "GET")).toBe(true);
  });

  it("blocks a same-name different-ID private Skill only in its dependency closure, without alias/rename/replace", async () => {
    const f = await fixture();
    f.targetSkills.set("native-skill", { id: "native-skill", name: "private-skill", origin: "upload", available: true, deleted: false,
      files: [{ path: "SKILL.md", size: 3, url: "https://eval.test/target-files/native" }] });
    const task = await f.preview();
    expect(task.view.agents.map((item) => item.status)).toEqual(["conflict", "ready"]);
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect(task.view.status).toBe("completed_with_errors");
    expect([...f.targetAgents.keys()]).toEqual([otherAgentId]);
    expect(posts(f, "/api/skills/imports")).toHaveLength(0);
    expect(f.targetSkills.get("native-skill")?.name).toBe("private-skill");
  });

  it.each(["path", "url", "reference-name"] as const)("isolates invalid source %s to its dependency closure and still applies an independent root", async (invalid) => {
    const snapshot = snapshotFixture();
    if (invalid === "path") snapshot.skills[0]!.files[1]!.path = "assets/100%.txt";
    else if (invalid === "url") snapshot.skills[0]!.files[1]!.url = "https://dev.test/api/private";
    else snapshot.references[0]!.name = "../brief.txt";
    const original = structuredClone(snapshot);
    const f = await fixture(snapshot);
    const task = await f.preview();
    expect(task.view.status).toBe("ready");
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["conflict", "ready"]);
    expect(task.plan!.eligibleAgentIds).toEqual([otherAgentId]);
    if (invalid !== "reference-name") {
      expect(task.plan!.resources.find((resource) => resource.kind === "skill" && resource.id === "private-skill")?.error)
        .toBeTruthy();
    }
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect(task.view.status).toBe("completed_with_errors");
    expect([...f.targetAgents.keys()]).toEqual([otherAgentId]);
    expect(posts(f, "/api/skills/imports")).toHaveLength(0);
    expect(posts(f, "/api/inbox/attachments")).toHaveLength(0);
    expect(f.requests.some((request) => new URL(request.url).pathname === "/api/private")).toBe(false);
    expect(f.requests.filter((request) => new URL(request.url).origin === "https://dev.test")
      .every((request) => request.method === "GET")).toBe(true);
    expect(snapshot).toEqual(original);
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it("keeps aggregate selected-union budget failures global rather than silently dropping the bad resource", async () => {
    const snapshot = snapshotFixture();
    snapshot.skills[0]!.files[1]!.size = IMPORT_LIMITS.totalBytes + 1;
    const f = await fixture(snapshot);
    const task = await f.preview();
    expect(task.view.status).toBe("failed");
    expect(task.view.error).toBe("Selected dependency union exceeds import limits");
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["failed", "failed"]);
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("does not claim/hide a native or unknown pre-existing Agent from a same-ID unknown intent", async () => {
    const f = await fixture();
    f.targetAgents.set(agentId, { id: agentId, user_id: owner, name: "Native", slug: "native", setting: {} });
    const task = await f.preview();
    expect(task.view.agents[0]?.status).toBe("conflict");
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect(f.targetAgents.get(agentId)?.name).toBe("Native");
    expect(f.sources.has(resourceKey("agent", agentId))).toBe(false);
    expect(await f.agents.list()).toContainEqual(expect.objectContaining({ id: agentId, name: "Native" }));
    expect(JSON.stringify(await f.agents.list())).not.toContain("sourceDigest");
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(1);
  });

  it("does not adopt a same-ID/same-content dependency without receipt provenance", async () => {
    const f = await fixture();
    f.targetSkills.set("private-skill", { id: "private-skill", name: "private-skill", origin: "upload", available: true, deleted: false,
      files: [{ path: "SKILL.md", size: 3, url: "https://eval.test/target-files/md" },
        { path: "scripts/run.py", size: 3, url: "https://eval.test/target-files/script" }] });
    const task = await f.preview();
    expect(task.view.agents[0]?.status).toBe("conflict");
    expect(f.sources.has(resourceKey("skill", "private-skill"))).toBe(false);
    expect(posts(f, "/api/skills/imports")).toHaveLength(0);
  });

  it("rejects a target private Skill still pointing at the dev CDN without downloading it or importing its Agent", async () => {
    const f = await fixture();
    f.targetSkills.set("private-skill", { id: "private-skill", name: "private-skill", origin: "upload", available: true, deleted: false,
      files: [{ path: "SKILL.md", size: 3, url: "https://creation-file-dev.springbrand.ai/skills/private/SKILL.md" },
        { path: "scripts/run.py", size: 3, url: "https://creation-file-dev.springbrand.ai/skills/private/scripts/run.py" }] });
    const task = await f.preview();
    expect(task.view.agents[0]).toMatchObject({ status: "conflict", message: "Untrusted import download address" });
    expect(task.view.agents[1]?.status).toBe("ready");
    expect(f.requests.some((request) => new URL(request.url).origin === "https://creation-file-dev.springbrand.ai")).toBe(false);
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(0);
  });

  it("reuses a legitimate receipt only after verifying the current complete target contents", async () => {
    const snapshot = snapshotFixture();
    const f = await fixture(snapshot);
    const first = await f.preview([agentId]);
    await f.store.apply(first.id, "apply"); await f.worker.run(first.id);
    snapshot.agents[1]!.setting = { ...snapshot.agents[1]!.setting, skillIds: ["private-skill"] };
    f.resetTask();
    const second = await f.preview();
    expect(second.view.agents.map((item) => item.status)).toEqual(["skipped", "ready"]);
    await f.store.apply(second.id, "another-apply"); await f.worker.run(second.id);
    expect(second.view.status).toBe("completed");
    expect(posts(f, "/api/skills/imports")).toHaveLength(1);
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(2);
  });

  it.each(["purpose", "source"] as const)("keeps a confirmed Agent after %s persistence failure and recovers by receipt, never DELETE/new ID", async (failure) => {
    const f = await fixture();
    const task = await f.preview();
    failure === "purpose" ? f.failNextPurpose() : f.failNextSource();
    await f.store.apply(task.id, "apply");
    await expect(f.worker.run(task.id)).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    expect(task.view.status).toBe("outcome_unknown");
    expect(f.targetAgents.has(agentId)).toBe(true);
    expect(f.intents.get(resourceKey("agent", agentId))?.receipt?.resourceId).toBe(agentId);
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
    const sourceReads = f.requests.filter((request) => new URL(request.url).origin === "https://dev.test").length;
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(f.sources.get(resourceKey("agent", agentId))?.origin).toBe("dev_import");
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(2);
    expect(f.requests.filter((request) => new URL(request.url).origin === "https://dev.test")).toHaveLength(sourceReads);
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  for (const localFailure of ["purpose", "source"] as const) {
    it.each(["deleted", "patched", "archived"] as const)(`does not finalize a cached confirmed receipt after ${localFailure} failure when the current Agent is %s`, async (change) => {
      const f = await fixture();
      const task = await f.preview([agentId]);
      localFailure === "purpose" ? f.failNextPurpose() : f.failNextSource();
      await f.store.apply(task.id, "apply");
      await expect(f.worker.run(task.id)).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
      const intent = f.intents.get(resourceKey("agent", agentId))!;
      expect(intent).toMatchObject({ status: "confirmed", receipt: { resourceId: agentId } });
      expect(f.purposes.upsert).toHaveBeenCalledTimes(1);
      const historicalReceipt = structuredClone(intent.receipt);
      const postCount = f.requests.filter((request) => request.method === "POST").length;
      if (change === "deleted") f.targetAgents.delete(agentId);
      else if (change === "archived") f.archiveAgent(agentId); // public GET retains its body, active list excludes it
      else f.targetAgents.set(agentId, { ...f.targetAgents.get(agentId)!, name: "Changed externally", setting: { mcpServers: [], skillIds: [] } });
      const before = f.requests.length;
      await f.worker.run(task.id);
      expect(task.view.status).toBe("completed_with_errors");
      expect(task.view.agents[0]?.status).toBe("conflict");
      expect(task.view.summary.created).toBe(0);
      expect(f.purposes.upsert).toHaveBeenCalledTimes(1);
      expect(f.sources.has(resourceKey("agent", agentId))).toBe(false);
      expect(intent.receipt).toEqual(historicalReceipt);
      expect(f.requests.slice(before).some((request) => request.method === "GET"
        && new URL(request.url).pathname === `/api/user-agent-configs/${agentId}`)).toBe(true);
      expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(postCount);
      expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
    });
  }

  it("calibrates a lost Skill import response, retaining the original intent/importKey and all files", async () => {
    const f = await fixture();
    const task = await f.preview();
    f.loseSkillResponse();
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(posts(f, "/api/skills/imports")).toHaveLength(1);
    expect(f.sources.get(resourceKey("skill", "private-skill"))?.receipt?.importKey).toBe(f.intents.get(resourceKey("skill", "private-skill"))?.importKey);
  });

  it("finalizes known receipts after preview TTL without starting any new remote import", async () => {
    const f = await fixture();
    const task = await f.preview();
    f.failNextPurpose();
    await f.store.apply(task.id, "apply");
    await expect(f.worker.run(task.id)).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    const before = f.requests.filter((request) => request.method === "POST").length;
    task.expiresAt = "2000-01-01T00:00:00.000Z";
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(before);
  });

  it("does not refetch a changed source after preview or overwrite a native Agent created before apply", async () => {
    const snapshot = snapshotFixture();
    const f = await fixture(snapshot);
    const task = await f.preview();
    snapshot.agents[0]!.name = "Changed upstream";
    f.targetAgents.set(agentId, { id: agentId, user_id: owner, name: "Racing native", setting: {} });
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect(task.view.status).toBe("completed_with_errors");
    expect(f.targetAgents.get(agentId)?.name).toBe("Racing native");
    expect(f.sources.has(resourceKey("agent", agentId))).toBe(false);
    expect(await f.agents.list()).toContainEqual(expect.objectContaining({ name: "Racing native" }));
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(1);
  });

  it("does not acknowledge a duplicate delivery as successful while another lease is active", async () => {
    const f = await fixture();
    const task = await f.store.create({ sourceUserId: sourceUser,
      agentIds: [agentId], purpose: "execution", idempotencyKey: "preview" }, f.source.connectionId);
    const result = await Promise.allSettled([f.worker.run(task.id), f.worker.run(task.id)]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(result.find((item) => item.status === "rejected")).toMatchObject({ reason: expect.any(ImportLeaseLostError) });
    expect(task.view.status).toBe("ready");
  });
});
