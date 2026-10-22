import { afterEach, describe, expect, it } from "vitest";
import { ImportConflictError, ImportDependencyError, ImportLeaseLostError, ImportOutcomeUnknownError, ImportTargetDisabledError } from "./errors.js";
import { IMPORT_LIMITS, resourceKey } from "./model.js";
import { planDigest } from "./semantics.js";
import { agentId, otherAgentId, owner, referenceId, sourceUser, snapshotFixture, workerFixture } from "./worker.test-support.js";

const fixtures: Awaited<ReturnType<typeof workerFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
async function fixture(snapshot = snapshotFixture()) {
  const value = await workerFixture(snapshot); fixtures.push(value); return value;
}
const posts = (f: Awaited<ReturnType<typeof workerFixture>>, pathname: string) =>
  f.requests.filter((request) => request.method === "POST" && new URL(request.url).pathname === pathname);
const resourceWrites = (f: Awaited<ReturnType<typeof workerFixture>>) => f.requests.filter((request) =>
  request.method !== "GET"
  && !(request.method === "POST"
    && new URL(request.url).pathname === "/api/agent-config-imports/validate"));

describe("durable import worker through approved public HTTP seams", () => {
  it("does not turn an already-confirmed legacy create-only plan into new overwrite writes", async () => {
    const f = await fixture();
    const task = await f.preview();
    await f.store.apply(task.id, "legacy-apply");
    task.plan = { ...task.plan!, version: 1 };
    task.plan.digest = planDigest(task.plan, task);
    await expect(f.worker.run(task.id, { final: true })).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    expect(task.view.status).toBe("outcome_unknown");
    expect(resourceWrites(f)).toEqual([]);
    expect(f.targetAgents.size).toBe(0);
  });

  it("finalizes a legacy task's proven receipt without rewriting its existing resource", async () => {
    const f = await fixture();
    const task = await f.preview([agentId]);
    await f.store.apply(task.id, "apply");
    f.failNextPurpose();
    await expect(f.worker.run(task.id)).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    const writes = resourceWrites(f).length;
    task.plan = { ...task.plan!, version: 1 };
    task.plan.digest = planDigest(task.plan, task);
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(resourceWrites(f)).toHaveLength(writes);
    expect(f.sources.get(resourceKey("agent", agentId))?.origin).toBe("dev_import");
  });

  it("overwrites an existing native Agent and its owned dependencies instead of skipping their IDs", async () => {
    const f = await fixture();
    f.targetAgents.set(agentId, { id: agentId, user_id: owner, slug: "existing", name: "Old Agent",
      setting: { ...snapshotFixture().agents[0]!.setting, systemPrompt: "Old prompt" } });
    await f.store.sources.recordNative(agentId);
    f.targetSkills.set("private-skill", { id: "private-skill", name: "Old Skill", origin: "upload", available: true, deleted: false,
      files: [{ path: "old.md", size: 3, url: "https://eval.test/target-files/old.md" }] });
    f.targetReferences.set(referenceId, { id: referenceId, name: "old.txt", mediaType: "text/plain", size: 99,
      status: "active", attachmentCdnUrl: "https://eval.test/target-files/old.txt" });
    const task = await f.preview([agentId]);
    expect(task.view.agents[0]).toMatchObject({ status: "ready", overwrite: true });
    await f.store.apply(task.id, "overwrite");
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(task.view.agents[0]?.status).toBe("overwritten");
    expect(task.view.summary).toMatchObject({ created: 0, overwritten: 1, skipped: 0 });
    expect(f.targetAgents.get(agentId)).toMatchObject({ id: agentId, name: "Source" });
    expect(f.targetSkills.get("private-skill")).toMatchObject({ id: "private-skill", name: "private-skill" });
    expect(f.targetReferences.get(referenceId)).toMatchObject({ id: referenceId, name: "brief.txt", size: 3 });
    expect(f.sources.get(resourceKey("agent", agentId))?.origin).toBe("dev_import");
    for (const path of ["/api/user-agent-configs/imports", "/api/skills/imports", "/api/user-references/imports"]) {
      expect(posts(f, path)).toHaveLength(1);
    }
  });

  it("uses fresh operation keys for a second import and restores same-ID resources from dev", async () => {
    const snapshot = snapshotFixture();
    const f = await fixture(snapshot);
    const first = await f.preview([agentId]);
    await f.store.apply(first.id, "first"); await f.worker.run(first.id);
    const oldKeys = first.plan!.resources.filter((resource) => !resource.platform).map((resource) => resource.importKey);
    f.targetAgents.set(agentId, { ...f.targetAgents.get(agentId)!, name: "Local edit" });
    snapshot.agents[0]!.name = "Updated dev Agent";
    snapshot.agents[0]!.setting = { ...snapshot.agents[0]!.setting, systemPrompt: "Updated dev prompt" };
    snapshot.references[0]!.name = "updated-brief.txt";
    f.resetTask();
    const next = await f.preview([agentId]);
    expect(next.view.agents[0]).toMatchObject({ status: "ready", overwrite: true });
    expect(next.plan!.resources.filter((resource) => !resource.platform).every((resource) => !oldKeys.includes(resource.importKey))).toBe(true);
    await f.store.apply(next.id, "second"); await f.worker.run(next.id);
    expect(next.view.status).toBe("completed");
    expect(next.view.summary).toMatchObject({ created: 0, overwritten: 1, skipped: 0 });
    expect(f.targetAgents.get(agentId)).toMatchObject({ name: "Updated dev Agent", setting: { systemPrompt: "Updated dev prompt" } });
    expect(f.targetReferences.get(referenceId)?.name).toBe("updated-brief.txt");
    for (const path of ["/api/user-agent-configs/imports", "/api/skills/imports", "/api/user-references/imports"]) {
      expect(posts(f, path)).toHaveLength(2);
    }
  });

  it.each(["bytes", "metadata", "bytes and metadata"] as const)("reimports changed Reference %s through retained immutable uploads without changing its final ID", async (change) => {
    const snapshot = snapshotFixture();
    const f = await fixture(snapshot);
    const first = await f.preview([agentId]);
    await f.store.apply(first.id, "first"); await f.worker.run(first.id);
    expect(first.view.status).toBe("completed");
    const previous = f.targetReferences.get(referenceId)!;
    const bytes = new TextEncoder().encode(change === "metadata" ? "abc" : "updated dev reference");
    const source = snapshot.references[0]!;
    if (change !== "bytes") {
      source.name = "updated-brief.md";
      source.mediaType = "text/markdown";
    }
    source.size = bytes.byteLength;
    f.setSourceFileBytes(source.url, bytes);
    f.resetTask();
    const next = await f.preview([agentId]);
    expect(next.view.agents[0]).toMatchObject({ status: "ready", overwrite: true });
    await f.store.apply(next.id, "second"); await f.worker.run(next.id);
    expect(next.view.status).toBe("completed");
    expect(next.view.summary).toMatchObject({ created: 0, overwritten: 1, skipped: 0 });
    expect([...f.targetReferences.keys()]).toEqual([referenceId]);
    const current = f.targetReferences.get(referenceId)!;
    expect(current).toMatchObject({ id: referenceId, name: source.name, mediaType: source.mediaType, size: bytes.byteLength });
    expect(await (await f.fetch(current.attachmentCdnUrl)).text()).toBe(new TextDecoder().decode(bytes));
    expect(await (await f.fetch(previous.attachmentCdnUrl)).text()).toBe("abc");
    const uploads = await Promise.all(posts(f, "/api/inbox/attachments").map((request) => request.clone().formData()));
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.get("clientAttachmentId")).not.toBe(uploads[1]!.get("clientAttachmentId"));
    expect(f.targetUploads.size).toBe(2); // Promotion retains the first immutable temporary upload.
    const imports = await Promise.all(posts(f, "/api/user-references/imports").map((request) => request.clone().json()));
    expect(imports.map((body) => body.referenceId)).toEqual([referenceId, referenceId]);
    expect(imports[0].importKey).not.toBe(imports[1].importKey);
    expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it("reuses one immutable temporary upload UUID after losing its response before attachment persistence", async () => {
    const f = await fixture();
    const task = await f.preview([agentId]);
    const sourceReads = f.requests.filter((request) => new URL(request.url).origin === "https://dev.test").length;
    f.setSourceFileBytes(snapshotFixture().references[0]!.url, new TextEncoder().encode("changed after preview"));
    await f.store.apply(task.id, "apply");
    let loseResponse = true;
    const fetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const response = await fetch(request);
      if (loseResponse && request.method === "POST" && new URL(request.url).pathname === "/api/inbox/attachments") {
        loseResponse = false;
        throw new TypeError("upload response lost after storage");
      }
      return response;
    });
    await expect(f.worker.run(task.id)).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    expect(task.view.status).toBe("importing");
    expect(f.intents.get(resourceKey("reference", referenceId))?.attachment).toBeNull();
    expect(f.targetUploads.size).toBe(1);
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    const uploads = await Promise.all(posts(f, "/api/inbox/attachments").map((request) => request.clone().formData()));
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.get("clientAttachmentId")).toBe(uploads[1]!.get("clientAttachmentId"));
    expect(uploads[0]!.get("clientAttachmentId")).not.toBe(referenceId);
    expect(f.targetUploads.size).toBe(1);
    expect(new TextDecoder().decode([...f.targetUploads.values()][0]!.bytes)).toBe("abc");
    expect([...f.targetReferences.keys()]).toEqual([referenceId]);
    expect(posts(f, "/api/user-references/imports")).toHaveLength(1);
    expect(f.requests.filter((request) => new URL(request.url).origin === "https://dev.test")).toHaveLength(sourceReads);
    expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it.each(["before-commit", "after-commit"] as const)("reuses the persisted Reference attachment and reconciles receipts after a lost import %s", async (failure) => {
    const f = await fixture();
    const task = await f.preview([agentId]);
    const plan = structuredClone(task.plan);
    const sourceReads = f.requests.filter((request) => new URL(request.url).origin === "https://dev.test").length;
    await f.store.apply(task.id, "apply");
    let recover = false;
    const fetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (!recover && path.includes("/receipts/") && f.targetReferences.has(referenceId)) {
        return Response.json({ code: "SERVICE_UNAVAILABLE", errMsg: "receipt unavailable" }, { status: 503 });
      }
      if (!recover && request.method === "POST" && path === "/api/user-references/imports") {
        if (failure === "after-commit") await fetch(request);
        else f.requests.push(request.clone());
        throw new TypeError("Reference import response lost");
      }
      return fetch(request);
    });
    await expect(f.worker.run(task.id)).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    expect(task.view.status).toBe("importing");
    const attachment = structuredClone(f.intents.get(resourceKey("reference", referenceId))!.attachment);
    expect(attachment).not.toBeNull();
    expect(attachment!.clientAttachmentId).not.toBe(referenceId);
    expect(posts(f, "/api/inbox/attachments")).toHaveLength(1);
    recover = true;
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(task.plan).toEqual(plan);
    expect(f.intents.get(resourceKey("reference", referenceId))?.attachment).toEqual(attachment);
    expect(posts(f, "/api/inbox/attachments")).toHaveLength(1);
    const imports = await Promise.all(posts(f, "/api/user-references/imports").map((request) => request.clone().json()));
    expect(imports).toHaveLength(failure === "before-commit" ? 2 : 1);
    for (const body of imports) expect(body).toMatchObject({ referenceId, attachment });
    expect([...f.targetReferences.keys()]).toEqual([referenceId]);
    expect(f.sources.get(resourceKey("reference", referenceId))?.receipt?.resourceId).toBe(referenceId);
    expect(f.requests.filter((request) => new URL(request.url).origin === "https://dev.test")).toHaveLength(sourceReads);
    expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("recovers an already-persisted legacy same-ID Reference attachment without replacing or uploading it again", async () => {
    const f = await fixture();
    const task = await f.preview([agentId]);
    await f.store.apply(task.id, "apply");
    const reference = task.plan!.resources.find((resource) => resource.kind === "reference")!;
    const form = new FormData();
    form.append("file", new Blob(["abc"], { type: "text/plain" }), "brief.txt");
    form.append("name", "brief.txt");
    form.append("clientAttachmentId", referenceId);
    const response = await f.fetch("https://eval.test/api/inbox/attachments", { method: "POST", body: form,
      headers: { Authorization: "Bearer target-session", Origin: "https://web.test" } });
    expect(response.status).toBe(200);
    const attachment = (await response.json()).msg;
    await f.store.saveAttachment(task, reference, attachment);
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(posts(f, "/api/inbox/attachments")).toHaveLength(1);
    const imports = posts(f, "/api/user-references/imports");
    expect(imports).toHaveLength(1);
    expect(await imports[0]!.clone().json()).toEqual({ referenceId, attachment, importKey: reference.importKey });
    expect([...f.targetReferences.keys()]).toEqual([referenceId]);
    expect(f.targetUploads.size).toBe(1);
    expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("rejects applying a new overwrite while a previous import still needs receipt finalization", async () => {
    const f = await fixture();
    const first = await f.preview([agentId]);
    await f.store.apply(first.id, "first");
    f.failNextPurpose();
    await expect(f.worker.run(first.id)).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    const writes = resourceWrites(f).length;
    f.resetTask();
    const next = await f.preview([agentId]);
    expect(next.view.agents[0]?.status).toBe("ready");
    await expect(f.store.apply(next.id, "blocked")).rejects.toBeInstanceOf(ImportConflictError);
    expect(resourceWrites(f)).toHaveLength(writes);
    await f.worker.run(first.id);
    expect(first.view.status).toBe("completed");
    expect(resourceWrites(f)).toHaveLength(writes);
  });

  it("allows a fresh overwrite after a known content conflict ended the previous task", async () => {
    const f = await fixture();
    const first = await f.preview([agentId]);
    await f.store.apply(first.id, "first");
    f.failNextPurpose();
    await expect(f.worker.run(first.id)).rejects.toBeInstanceOf(ImportOutcomeUnknownError);
    f.targetAgents.set(agentId, { ...f.targetAgents.get(agentId)!, name: "Later local edit" });
    await f.worker.run(first.id);
    expect(first.view.status).toBe("completed_with_errors");
    f.resetTask();
    const next = await f.preview([agentId]);
    expect(next.view.agents[0]?.status).toBe("ready");
    await f.store.apply(next.id, "next"); await f.worker.run(next.id);
    expect(next.view.status).toBe("completed");
    expect(next.view.agents[0]?.status).toBe("overwritten");
    expect(f.targetAgents.get(agentId)?.name).toBe("Source");
  });

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

  it("does not let an old receipt conflict block an explicitly requested new overwrite", async () => {
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
    expect(next.view.agents.map((agent) => agent.status)).toEqual(["ready", "ready"]);
    const before = posts(f, "/api/user-agent-configs/imports").length;
    await f.store.apply(next.id, "next-apply"); await f.worker.run(next.id);
    expect(next.view.status).toBe("completed");
    expect(next.view.agents.map((agent) => agent.status)).toEqual(["overwritten", "created"]);
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(before + 2);
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
    expect(resourceWrites(f)).toEqual([]);
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
    const writes = resourceWrites(f).length;
    f.setTargetEnabled(false);
    await expect(f.worker.run(task.id, { final })).rejects.toBeInstanceOf(ImportTargetDisabledError);
    expect(task.view.status).toBe(final ? "outcome_unknown" : "importing");
    expect(task.view.progress.stage).toBe("receipts");
    expect(task.plan).toEqual(plan);
    expect(task.applyKey).toBe("apply");
    expect(f.intents.get(resourceKey("agent", agentId))).toEqual(intent);
    expect(f.targetAgents.has(agentId)).toBe(true);
    expect(resourceWrites(f)).toHaveLength(writes);
    f.setTargetEnabled(true);
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(resourceWrites(f)).toHaveLength(writes);
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
    expect(resourceWrites(f)).toEqual([]);
  });
  it("prepares only the selected union, imports all Skill bytes and target attachments, dependencies before same-ID Agents", async () => {
    const f = await fixture();
    const task = await f.preview();
    expect(task.view.agents.map((item) => item.status)).toEqual(["ready", "ready"]);
    expect(resourceWrites(f)).toEqual([]);
    expect(f.requests.some((request) => request.url.endsWith("/unused"))).toBe(false);
    await f.store.apply(task.id, "apply");
    expect(f.events.at(-1)).toBe("enqueue:apply");
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(task.view.summary).toEqual({ created: 2, overwritten: 0, skipped: 0, failed: 0, conflicts: 0 });
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

  it("honors a target preflight same-name different-ID Skill conflict only in its dependency closure, without alias/rename/replace", async () => {
    const f = await fixture();
    f.targetSkills.set("native-skill", { id: "native-skill", name: "private-skill", origin: "upload", available: true, deleted: false,
      files: [{ path: "SKILL.md", size: 3, url: "https://eval.test/target-files/native" }] });
    const transport = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/api/agent-config-imports/validate") {
        const body = await request.clone().json();
        if (body.setting.skillIds.includes("private-skill")) {
          f.requests.push(request.clone());
          expect(body.plannedResources.skills).toEqual([{ id: "private-skill", name: "private-skill" }]);
          return Response.json({ code: "AGENT_CONFIG_IMPORT_CONFLICT", errMsg: "Target Skill runtime name conflicts" }, { status: 409 });
        }
      }
      return transport(request);
    });
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
    expect(resourceWrites(f)).toEqual([]);
  });

  it("does not claim/hide a native or unknown pre-existing Agent from a same-ID unknown intent", async () => {
    const f = await fixture();
    f.targetAgents.set(agentId, { id: agentId, user_id: owner, name: "Native", slug: "native", setting: {} });
    const initial = await f.preview();
    const pending = initial.plan!.resources.find((resource) => resource.kind === "agent" && resource.id === agentId)!;
    f.intents.set(resourceKey("agent", agentId), { ...pending, ownerUserId: owner, connectionId: initial.connectionId,
      sourceUserId: sourceUser, status: "outcome_unknown", receipt: null, attachment: null });
    f.resetTask();
    const task = await f.preview();
    expect(task.view.agents[0]?.status).toBe("conflict");
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect(f.targetAgents.get(agentId)?.name).toBe("Native");
    expect(f.sources.has(resourceKey("agent", agentId))).toBe(false);
    expect(await f.agents.list()).toContainEqual(expect.objectContaining({ id: agentId, name: "Native" }));
    expect(JSON.stringify(await f.agents.list())).not.toContain("sourceDigest");
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(1);
  });

  it("overwrites a matching pre-existing dependency and registers only its new verified receipt", async () => {
    const f = await fixture();
    f.targetSkills.set("private-skill", { id: "private-skill", name: "private-skill", origin: "upload", available: true, deleted: false,
      files: [{ path: "SKILL.md", size: 3, url: "https://eval.test/target-files/md" },
        { path: "scripts/run.py", size: 3, url: "https://eval.test/target-files/script" }] });
    const task = await f.preview();
    expect(task.view.agents[0]?.status).toBe("ready");
    expect(f.sources.has(resourceKey("skill", "private-skill"))).toBe(false);
    expect(posts(f, "/api/skills/imports")).toHaveLength(0);
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect(posts(f, "/api/skills/imports")).toHaveLength(1);
    expect(f.sources.get(resourceKey("skill", "private-skill"))?.receipt).toBeTruthy();
  });

  it("replaces a private Skill's stale dev CDN pointers without downloading the old target content", async () => {
    const f = await fixture();
    f.targetSkills.set("private-skill", { id: "private-skill", name: "private-skill", origin: "upload", available: true, deleted: false,
      files: [{ path: "SKILL.md", size: 3, url: "https://creation-file-dev.springbrand.ai/skills/private/SKILL.md" },
        { path: "scripts/run.py", size: 3, url: "https://creation-file-dev.springbrand.ai/skills/private/scripts/run.py" }] });
    const task = await f.preview();
    expect(task.view.agents[0]?.status).toBe("ready");
    expect(task.view.agents[1]?.status).toBe("ready");
    expect(f.requests.some((request) => new URL(request.url).origin === "https://creation-file-dev.springbrand.ai")).toBe(false);
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(0);
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(f.requests.some((request) => new URL(request.url).origin === "https://creation-file-dev.springbrand.ai")).toBe(false);
    expect(f.targetSkills.get("private-skill")?.files.every((file) => new URL(file.url).origin === "https://eval.test")).toBe(true);
  });

  it("overwrites shared dependencies once per new task rather than reusing an earlier import operation", async () => {
    const snapshot = snapshotFixture();
    const f = await fixture(snapshot);
    const first = await f.preview([agentId]);
    await f.store.apply(first.id, "apply"); await f.worker.run(first.id);
    snapshot.agents[1]!.setting = { ...snapshot.agents[1]!.setting, skillIds: ["private-skill"] };
    f.resetTask();
    const second = await f.preview();
    expect(second.view.agents.map((item) => item.status)).toEqual(["ready", "ready"]);
    await f.store.apply(second.id, "another-apply"); await f.worker.run(second.id);
    expect(second.view.status).toBe("completed");
    expect(posts(f, "/api/skills/imports")).toHaveLength(2);
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(3);
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
    const writes = resourceWrites(f).length;
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
    expect(resourceWrites(f)).toHaveLength(writes);
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
      const postCount = resourceWrites(f).length;
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
      expect(resourceWrites(f)).toHaveLength(postCount);
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
    const before = resourceWrites(f).length;
    task.expiresAt = "2000-01-01T00:00:00.000Z";
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(resourceWrites(f)).toHaveLength(before);
  });

  it("uses the frozen source when overwriting an owned Agent created between preview and apply", async () => {
    const snapshot = snapshotFixture();
    const f = await fixture(snapshot);
    const task = await f.preview();
    snapshot.agents[0]!.name = "Changed upstream";
    f.targetAgents.set(agentId, { id: agentId, user_id: owner, name: "Racing native", setting: {} });
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(f.targetAgents.get(agentId)?.name).toBe("Source");
    expect(f.sources.get(resourceKey("agent", agentId))?.origin).toBe("dev_import");
    expect(await f.agents.list()).toContainEqual(expect.objectContaining({ name: "Source" }));
    expect(task.view.agents[0]?.status).toBe("overwritten");
    expect(posts(f, "/api/user-agent-configs/imports")).toHaveLength(2);
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
