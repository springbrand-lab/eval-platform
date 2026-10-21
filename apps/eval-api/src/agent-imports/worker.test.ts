import { afterEach, describe, expect, it } from "vitest";
import { ImportDependencyError, ImportLeaseLostError, ImportOutcomeUnknownError, ImportTargetDisabledError } from "./errors.js";
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

  it.each([false, true])("retains the same apply without target writes while disabled before execution (final: %s)", async (final) => {
    const f = await fixture();
    const task = await f.preview();
    const plan = structuredClone(task.plan);
    await f.store.apply(task.id, "apply");
    f.setTargetEnabled(false);
    const savedBefore = f.savedViews.length;
    await expect(f.worker.run(task.id, { final })).rejects.toBeInstanceOf(ImportTargetDisabledError);
    expect(task.view.status).toBe(final ? "outcome_unknown" : "importing");
    expect(task.view.progress.stage).toBe("receipts");
    expect(task.plan).toEqual(plan);
    expect(task.applyKey).toBe("apply");
    expect(f.savedViews.slice(savedBefore).map((view) => view.status)).toEqual([final ? "outcome_unknown" : "importing"]);
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    f.setTargetEnabled(true);
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
  });

  it.each([false, true])("preserves earlier writes and their receipts while disabled before reconciliation (final: %s)", async (final) => {
    const f = await fixture();
    const task = await f.preview();
    const plan = structuredClone(task.plan);
    await f.store.apply(task.id, "apply");
    f.failNextPurpose();
    await expect(f.worker.run(task.id)).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    const intent = structuredClone(f.intents.get(resourceKey("agent", agentId))!);
    const writes = f.requests.filter((request) => request.method === "POST").length;
    f.setTargetEnabled(false);
    await expect(f.worker.run(task.id, { final })).rejects.toBeInstanceOf(ImportTargetDisabledError);
    expect(task.view.status).toBe(final ? "outcome_unknown" : "importing");
    expect(task.view.progress.stage).toBe("receipts");
    expect(task.plan).toEqual(plan);
    expect(task.applyKey).toBe("apply");
    expect(f.intents.get(resourceKey("agent", agentId))).toEqual(intent);
    expect(f.targetAgents.has(agentId)).toBe(true);
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(writes);
    f.setTargetEnabled(true);
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(writes);
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it("keeps a transient preview checking, then fails it only when the delivery budget is exhausted", async () => {
    const f = await fixture();
    const task = await f.store.create({ sourceUserId: sourceUser,
      agentIds: [agentId], purpose: "execution", idempotencyKey: "preview" }, f.source.connectionId);
    const fetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin === "https://dev.test") {
        return Response.json({ code: "SERVICE_UNAVAILABLE", errMsg: "unavailable" }, { status: 503 });
      }
      return fetch(request);
    });
    await expect(f.worker.run(task.id)).rejects.toBeInstanceOf(ImportDependencyError);
    expect(task.view.status).toBe("checking");
    expect(task.view.agents[0]?.status).toBe("pending");
    await expect(f.worker.run(task.id, { final: true })).rejects.toBeInstanceOf(ImportDependencyError);
    expect(task.view.status).toBe("failed");
    expect(task.view.agents[0]?.status).toBe("failed");
    expect(task.applyKey).toBeNull();
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("fails a deterministic global apply conflict without treating it as recoverable receipt work", async () => {
    const f = await fixture();
    const task = await f.preview();
    await f.store.apply(task.id, "apply");
    task.connectionId = "different-source";
    await expect(f.worker.run(task.id)).resolves.toBeUndefined();
    expect(task.view.status).toBe("failed");
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["failed", "failed"]);
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
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
    if (invalid === "path") snapshot.skills[0]!.files[1]!.path = "assets/../brief.txt";
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

  it.each(["purpose", "source"] as const)("keeps receipt recovery active after %s persistence failure and completes on the next delivery, never DELETE/new ID", async (failure) => {
    const f = await fixture();
    const task = await f.preview();
    failure === "purpose" ? f.failNextPurpose() : f.failNextSource();
    await f.store.apply(task.id, "apply");
    const savedBefore = f.savedViews.length;
    await expect(f.worker.run(task.id)).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    expect(task.view.status).toBe("importing");
    expect(task.view.progress.stage).toBe("receipts");
    expect(task.view.error).toContain("background recovery will continue");
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["outcome_unknown", "created"]);
    expect(f.savedViews.slice(savedBefore).every((view) => view.status === "importing")).toBe(true);
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

  it("publishes terminal outcome_unknown only after the final unsuccessful local reconciliation, preserving the receipt and plan", async () => {
    const f = await fixture();
    const task = await f.preview([agentId]);
    const plan = structuredClone(task.plan);
    await f.store.apply(task.id, "apply");
    f.failNextPurpose();
    await expect(f.worker.run(task.id)).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    expect(task.view.status).toBe("importing");
    const intent = structuredClone(f.intents.get(resourceKey("agent", agentId))!);
    const writes = f.requests.filter((request) => request.method === "POST").length;
    f.failNextPurpose();
    await expect(f.worker.run(task.id, { final: true })).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    expect(task.view.status).toBe("outcome_unknown");
    expect(task.view.progress.stage).toBe("receipts");
    expect(task.view.error).toContain("Automatic import recovery is exhausted");
    expect(task.view.agents[0]?.status).toBe("outcome_unknown");
    expect(task.plan).toEqual(plan);
    expect(task.applyKey).toBe("apply");
    expect(f.intents.get(resourceKey("agent", agentId))).toEqual(intent);
    expect(f.targetAgents.has(agentId)).toBe(true);
    expect(f.sources.has(resourceKey("agent", agentId))).toBe(false);
    expect(f.savedViews.filter((view) => view.status === "outcome_unknown")).toHaveLength(1);
    expect(f.savedViews.at(-1)?.status).toBe("outcome_unknown");
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(writes);
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not mislabel committed writes when task completion persistence fails (final: %s)", async (final) => {
    const f = await fixture();
    const task = await f.preview([otherAgentId]);
    const plan = structuredClone(task.plan);
    await f.store.apply(task.id, "apply");
    f.failNextCompletion();
    const savedBefore = f.savedViews.length;
    await expect(f.worker.run(task.id, { final })).rejects.toThrow("task DB offline");
    expect(task.view.status).toBe(final ? "outcome_unknown" : "importing");
    expect(task.view.progress.stage).toBe("receipts");
    expect(task.view.agents[0]?.status).toBe("created");
    expect(task.plan).toEqual(plan);
    expect(task.applyKey).toBe("apply");
    expect(f.intents.get(resourceKey("agent", otherAgentId))).toMatchObject({
      status: "completed", receipt: { resourceId: otherAgentId },
    });
    expect([...f.targetAgents.keys()]).toEqual([otherAgentId]);
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(1);
    expect(f.savedViews.slice(savedBefore).some((view) => ["failed", "completed"].includes(view.status))).toBe(false);
    if (!final) {
      expect(f.savedViews.slice(savedBefore).some((view) => view.status === "outcome_unknown")).toBe(false);
      await f.worker.run(task.id);
      expect(task.view.status).toBe("completed");
      expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(1);
    }
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps a lost Agent write active, preserving its identity if receipt retries exhaust (final: %s)", async (final) => {
    const f = await fixture();
    const task = await f.preview([otherAgentId]);
    await f.store.apply(task.id, "apply");
    const key = task.plan!.resources.find((resource) => resource.kind === "agent")!.importKey;
    let unavailable = true;
    const fetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (unavailable && f.targetAgents.has(otherAgentId) && path === `/api/agent-config-imports/receipts/${key}`) {
        return Response.json({ code: "SERVICE_UNAVAILABLE", errMsg: "unavailable" }, { status: 503 });
      }
      const response = await fetch(request);
      if (unavailable && request.method === "POST" && path === "/api/user-agent-configs/imports") {
        throw new TypeError("response lost after insert");
      }
      return response;
    });
    const savedBefore = f.savedViews.length;
    await expect(f.worker.run(task.id)).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    expect(task.view.status).toBe("importing");
    expect(task.view.progress.stage).toBe("receipts");
    expect(task.view.agents[0]?.status).toBe("outcome_unknown");
    expect(f.savedViews.slice(savedBefore).every((view) => view.status === "importing")).toBe(true);
    expect(f.intents.get(resourceKey("agent", otherAgentId))).toMatchObject({ status: "outcome_unknown", importKey: key });
    expect(f.targetAgents.has(otherAgentId)).toBe(true);
    expect(f.sources.has(resourceKey("agent", otherAgentId))).toBe(false);
    if (final) {
      await expect(f.worker.run(task.id, { final: true })).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
      expect(task.view.status).toBe("outcome_unknown");
      expect(task.view.progress.stage).toBe("receipts");
      expect(f.intents.get(resourceKey("agent", otherAgentId))).toMatchObject({ status: "outcome_unknown", importKey: key });
      expect(f.sources.has(resourceKey("agent", otherAgentId))).toBe(false);
      expect(f.savedViews.filter((view) => view.status === "outcome_unknown")).toHaveLength(1);
    }
    unavailable = false;
    await f.worker.run(task.id, { final: true });
    expect(task.view.status).toBe("completed");
    expect(f.sources.get(resourceKey("agent", otherAgentId))?.receipt?.importKey).toBe(key);
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(1);
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
