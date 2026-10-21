import { afterEach, describe, expect, it } from "vitest";
import { equalJson } from "@eval-platform/eval-contracts";
import { ImportConflictError, ImportDependencyError } from "./errors.js";
import { digest, resourceKey, type SourceSnapshot } from "./model.js";
import { agentId, otherAgentId, referenceId, snapshotFixture, workerFixture } from "./worker.test-support.js";

type Evidence = { kind: "action" | "connector" | "extension"; id: string; fingerprint: string };
const proofs: Evidence[] = [
  { kind: "extension", id: "extension-selected", fingerprint: "e".repeat(64) },
  { kind: "action", id: "action-selected", fingerprint: "a".repeat(64) },
  { kind: "connector", id: "connector-selected", fingerprint: "c".repeat(64) },
];
const sortedProofs = [proofs[1]!, proofs[2]!, proofs[0]!];
const fixtures: Awaited<ReturnType<typeof workerFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
const ok = (msg: unknown) => Response.json({ success: true, msg, code: "", errMsg: "" });
const conflict = () => Response.json({ code: "AGENT_CONFIG_IMPORT_CONFLICT", errMsg: "definition is unavailable" }, { status: 409 });
const resourceWrites = (f: Awaited<ReturnType<typeof workerFixture>>) => f.requests.filter((request) =>
  request.method === "POST"
  && new URL(request.url).pathname !== "/api/agent-config-imports/validate");
const probes = (f: Awaited<ReturnType<typeof workerFixture>>) => f.requests.filter((request) =>
  new URL(request.url).pathname === "/api/agent-config-imports/validate");

function snapshotWithSelections(evidence: Evidence[] | undefined = structuredClone(proofs)): SourceSnapshot & { dependencies?: Evidence[] } {
  const snapshot = snapshotFixture();
  Object.assign(snapshot.agents[0]!.setting, {
    actionIds: ["action-selected"], connectorIds: ["connector-selected"], extensionIds: ["extension-selected"],
  });
  return evidence === undefined ? snapshot : { ...snapshot, dependencies: evidence };
}

/** Uses the real source/target adapters, planner, Agent service and worker; only public HTTP data are faked. */
async function fixture(snapshot = snapshotWithSelections()) {
  const f = await workerFixture(snapshot);
  fixtures.push(f);
  const targetProofs = structuredClone(proofs);
  let status = 200;
  const fetch = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/api/agent-config-imports/validate") {
      f.requests.push(request.clone());
      expect(request.method).toBe("POST");
      expect(request.headers.get("Authorization")).toBe("Bearer target-session");
      expect(request.headers.get("Origin")).toBe("https://web.test");
      const body = await request.json() as { setting: Record<string, unknown>; dependencies: Evidence[] };
      expect(Object.keys(body).sort()).toEqual(["dependencies", "plannedResources", "setting"]);
      expect(body.dependencies.length).toBeLessThanOrEqual(500);
      if (body.dependencies.length > 0) {
        if (status !== 200) return status === 409 ? conflict() : Response.json({ code: "AUTH_UNAUTHENTICATED", errMsg: "private upstream" }, { status });
        if (body.dependencies.some((expected) => !targetProofs.some((current) => equalJson(current, expected)))) return conflict();
      }
      return ok({ version: 1, setting: body.setting }); // The target compares the supplied immutable proofs, not an Eval metadata query.
    }
    return fetch(request);
  });
  return { ...f, targetProofs, setStatus: (value: number) => { status = value; } };
}

describe("selected public capability definition evidence", () => {
  it("freezes source proofs into both digests/import keys and sends exactly those proofs on the Agent POST", async () => {
    const snapshot = snapshotWithSelections();
    const f = await fixture(snapshot);
    const task = await f.preview();
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["ready", "ready"]);
    expect(resourceWrites(f)).toEqual([]);
    expect(probes(f)).toHaveLength(2);
    const resource = task.plan!.resources.find((resource) => resource.kind === "agent" && resource.id === agentId)!;
    expect(await probes(f)[0]!.clone().json()).toEqual({
      setting: resource.prepared!.config.setting, dependencies: sortedProofs,
      plannedResources: { skills: [{ id: "private-skill", name: "private-skill" }], references: [{ id: referenceId, size: 3 }] },
    });
    expect(f.requests.some((request) => /^\/api\/(?:actions|components|connectors|model-catalog)(?:\/|$)/u.test(new URL(request.url).pathname)
      || new URL(request.url).pathname === "/api/agent-config-imports/dependencies")).toBe(false);
    expect(resource.prepared).toMatchObject({ dependencies: sortedProofs });
    expect(resource.sourceDigest).toBe(digest({ version: 1, source: resource.source, dependencies: sortedProofs }));
    expect(resource.targetDigest).toBe(digest({ version: 1, prepared: resource.prepared }));
    const frozen = structuredClone(resource.prepared);
    const sourceReads = f.requests.filter((request) => new URL(request.url).origin === "https://dev.test").length;
    snapshot.dependencies![0]!.fingerprint = "b".repeat(64); // changing dev after preview cannot change the frozen request
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    const post = resourceWrites(f).find((request) => new URL(request.url).pathname === "/api/user-agent-configs/imports"
      && request.url.includes("https://eval.test"))!;
    expect(await post.clone().json()).toEqual({ ...frozen!.config, dependencies: sortedProofs, importKey: resource.importKey });
    expect(f.requests.filter((request) => new URL(request.url).origin === "https://dev.test")).toHaveLength(sourceReads);
    expect(f.requests.every((request) => !["PATCH", "DELETE", "PUT"].includes(request.method))).toBe(true);
    expect(f.requests.filter((request) => new URL(request.url).origin === "https://dev.test")
      .every((request) => request.method === "GET")).toBe(true);
    expect(JSON.stringify(await f.agents.list())).not.toContain("fingerprint");
    expect(JSON.stringify(await f.agents.list())).not.toContain("dependencies");
  });

  it("changes source/target digests and import keys when the selected source definition changes", async () => {
    const f = await fixture();
    const first = await f.preview([agentId]);
    const before = first.plan!.resources.find((resource) => resource.kind === "agent")!;
    const snapshot = snapshotWithSelections();
    snapshot.dependencies![1]!.fingerprint = "b".repeat(64);
    const next = await fixture(snapshot);
    next.targetProofs[1]!.fingerprint = "b".repeat(64);
    const second = await next.preview([agentId]);
    expect(second.view.agents[0]?.status).toBe("ready");
    const after = second.plan!.resources.find((resource) => resource.kind === "agent")!;
    expect(after.source).toEqual(before.source);
    for (const field of ["sourceDigest", "targetDigest", "importKey"] as const) expect(after[field]).not.toBe(before[field]);
  });

  it("blocks only a selected-capability root on an older export with no source proofs; empty-capability roots remain eligible", async () => {
    const snapshot = snapshotWithSelections();
    delete (snapshot as Partial<SourceSnapshot>).dependencies;
    const f = await fixture(snapshot);
    const task = await f.preview();
    expect(task.view.status).toBe("ready");
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["conflict", "ready"]);
    expect(task.plan!.eligibleAgentIds).toEqual([otherAgentId]);
    expect(probes(f)).toHaveLength(1);
    expect(await probes(f)[0]!.clone().json()).toMatchObject({ dependencies: [], setting: snapshot.agents[1]!.setting });
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect([...f.targetAgents.keys()]).toEqual([otherAgentId]);
    expect(resourceWrites(f).map((request) => new URL(request.url).pathname)).toEqual(["/api/user-agent-configs/imports"]);
  });

  it("blocks duplicate source kind/ID proofs only in their root rather than selecting an arbitrary version", async () => {
    const snapshot = snapshotWithSelections([...structuredClone(proofs), { ...proofs[1]!, fingerprint: "b".repeat(64) }]);
    const f = await fixture(snapshot);
    const task = await f.preview();
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["conflict", "ready"]);
    expect(probes(f)).toHaveLength(1);
    expect(await probes(f)[0]!.clone().json()).toMatchObject({ dependencies: [], setting: snapshot.agents[1]!.setting });
    expect(resourceWrites(f)).toEqual([]);
  });

  it.each(["different-version", "unavailable"] as const)("rejects a same-ID %s target definition during preview without publication/adoption", async (change) => {
    const f = await fixture();
    if (change === "different-version") f.targetProofs[1]!.fingerprint = "b".repeat(64);
    else f.setStatus(409);
    const task = await f.preview();
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["conflict", "ready"]);
    expect(probes(f)).toHaveLength(2);
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect([...f.targetAgents.keys()]).toEqual([otherAgentId]);
    expect(resourceWrites(f).map((request) => new URL(request.url).pathname)).toEqual(["/api/user-agent-configs/imports"]);
  });

  it.each([
    [proofs[1]!, proofs[1]!, proofs[0]!],
    [proofs[1]!, proofs[2]!],
    [proofs[1]!, proofs[2]!, { ...proofs[0]!, kind: "action" as const }],
    [proofs[1]!, proofs[2]!, { ...proofs[0]!, id: "unselected" }],
  ])("rejects malformed source proof coverage at the public Agent service before target preflight", async (...items) => {
    const f = await fixture();
    await expect(f.agents.prepareImport(snapshotWithSelections().agents[0]!, "execution", items))
      .rejects.toBeInstanceOf(ImportConflictError);
    expect(probes(f)).toEqual([]);
    expect(resourceWrites(f)).toEqual([]);
  });

  it("revalidates frozen evidence before ANY apply resource write and isolates a drifted root", async () => {
    const f = await fixture();
    const task = await f.preview();
    const plan = structuredClone(task.plan);
    const sourceReads = f.requests.filter((request) => new URL(request.url).origin === "https://dev.test").length;
    const before = f.requests.length;
    f.targetProofs[1]!.fingerprint = "b".repeat(64);
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect(task.view.status).toBe("completed_with_errors");
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["conflict", "created"]);
    expect(resourceWrites(f).map((request) => new URL(request.url).pathname)).toEqual(["/api/user-agent-configs/imports"]);
    expect(f.requests.slice(before).some((request) => new URL(request.url).pathname === "/api/agent-config-imports/validate")).toBe(true);
    expect(task.plan).toEqual(plan);
    expect(f.intents.get(resourceKey("agent", agentId))?.status).toBe("conflict");
    expect(f.sources.has(resourceKey("agent", agentId))).toBe(false);
    expect(f.requests.filter((request) => new URL(request.url).origin === "https://dev.test")).toHaveLength(sourceReads);
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it("does not finalize a historical Agent receipt when its selected target definition later drifts", async () => {
    const f = await fixture();
    const task = await f.preview([agentId]);
    f.failNextPurpose();
    await f.store.apply(task.id, "apply");
    await expect(f.worker.run(task.id)).rejects.toMatchObject({ code: "EVAL_SP_UNAVAILABLE" });
    const intent = f.intents.get(resourceKey("agent", agentId))!;
    expect(intent).toMatchObject({ status: "confirmed", receipt: { resourceId: agentId } });
    const confirmed = structuredClone(intent.receipt);
    const writes = resourceWrites(f).length;
    expect(f.purposes.upsert).toHaveBeenCalledTimes(1);
    f.targetProofs[1]!.fingerprint = "b".repeat(64);
    await f.worker.run(task.id);
    expect(task.view.agents[0]?.status).toBe("conflict");
    expect(task.view.status).toBe("completed_with_errors");
    expect(f.sources.has(resourceKey("agent", agentId))).toBe(false);
    expect(intent.receipt).toEqual(confirmed);
    expect(intent.status).toBe("confirmed");
    expect(resourceWrites(f)).toHaveLength(writes);
    expect(f.purposes.upsert).toHaveBeenCalledTimes(1);
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it("uses current definition evidence for receipt-only TTL recovery without source calls or new resource writes", async () => {
    const f = await fixture();
    const task = await f.preview();
    f.failNextPurpose();
    await f.store.apply(task.id, "apply");
    await expect(f.worker.run(task.id)).rejects.toMatchObject({ code: "EVAL_SP_UNAVAILABLE" });
    const writes = resourceWrites(f).length;
    const sourceReads = f.requests.filter((request) => new URL(request.url).origin === "https://dev.test").length;
    const probesBefore = probes(f).length;
    task.expiresAt = "2000-01-01T00:00:00.000Z";
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(resourceWrites(f)).toHaveLength(writes);
    expect(probes(f).length).toBeGreaterThan(probesBefore);
    expect(f.requests.filter((request) => new URL(request.url).origin === "https://dev.test")).toHaveLength(sourceReads);
    expect(f.sp.deleteAgentConfig).not.toHaveBeenCalled();
  });

  it.each([401, 503])("pauses apply on target evidence HTTP %i with no remote resource writes, then resumes the same plan", async (status) => {
    const f = await fixture();
    const task = await f.preview();
    const plan = structuredClone(task.plan);
    await f.store.apply(task.id, "apply");
    f.setStatus(status);
    await expect(f.worker.run(task.id)).rejects.toBeInstanceOf(ImportDependencyError);
    expect(resourceWrites(f)).toEqual([]);
    expect(task.view.status).toBe("importing");
    expect(task.view.progress.stage).toBe("receipts");
    expect(task.plan).toEqual(plan);
    f.setStatus(200);
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(task.plan).toEqual(plan);
  });

  it("finishes a committed Agent POST with an unknown 409 through its receipt, without another resource write", async () => {
    const f = await fixture();
    const fetch = f.fetch.getMockImplementation()!;
    let intercepted = false;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const response = await fetch(request);
      if (!intercepted && request.method === "POST" && new URL(request.url).pathname === "/api/user-agent-configs/imports") {
        intercepted = true;
        return Response.json({ code: "UNKNOWN_PROXY_CONFLICT", errMsg: "Unverified response" }, { status: 409 });
      }
      return response;
    });
    const task = await f.preview();
    await f.store.apply(task.id, "apply");
    await f.worker.run(task.id);
    expect(intercepted).toBe(true);
    expect(task.view.status).toBe("completed");
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["created", "created"]);
    const writes = resourceWrites(f).filter((request) => new URL(request.url).pathname === "/api/user-agent-configs/imports");
    expect(await Promise.all(writes.map(async (request) => (await request.clone().json() as { id: string }).id)))
      .toEqual([agentId, otherAgentId]);
  });

  it("keeps an unverifiable Agent POST active and resumes the same plan without rewriting completed dependencies", async () => {
    const f = await fixture();
    const fetch = f.fetch.getMockImplementation()!;
    let unavailable = true;
    f.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (unavailable && request.method === "POST" && new URL(request.url).pathname === "/api/user-agent-configs/imports"
        && (await request.clone().json() as { id: string }).id === agentId) {
        f.requests.push(request.clone());
        return Response.json({ code: "UNKNOWN_PROXY_CONFLICT", errMsg: "Unverified response" }, { status: 409 });
      }
      return fetch(request);
    });
    const task = await f.preview();
    const plan = structuredClone(task.plan);
    await f.store.apply(task.id, "apply");
    await expect(f.worker.run(task.id)).rejects.toMatchObject({ code: "EVAL_SP_UNAVAILABLE" });
    expect(task.view.status).toBe("importing");
    expect(task.view.progress.stage).toBe("receipts");
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["outcome_unknown", "created"]);
    const dependencyWrites = () => resourceWrites(f).filter((request) =>
      new URL(request.url).pathname !== "/api/user-agent-configs/imports");
    const completedDependencyWrites = dependencyWrites().length;
    unavailable = false;
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["created", "created"]);
    expect(task.plan).toEqual(plan);
    expect(dependencyWrites()).toHaveLength(completedDependencyWrites);
  });

  it("guards the authoritative preflight POST with target import capability, without confusing it with a resource mutation", async () => {
    const f = await fixture();
    f.setTargetEnabled(false);
    await expect(f.agents.prepareImport(snapshotWithSelections().agents[0]!, "execution", proofs))
      .rejects.toMatchObject({ code: "EVAL_SP_UNAVAILABLE" });
    expect(probes(f)).toEqual([]);
    expect(resourceWrites(f)).toEqual([]);
  });

  it("rejects selected capabilities with no evidence in the public Agent service as well as the worker", async () => {
    const f = await fixture();
    await expect(f.agents.prepareImport(snapshotWithSelections().agents[0]!, "execution"))
      .rejects.toBeInstanceOf(ImportConflictError);
    expect(probes(f)).toEqual([]);
    expect(resourceWrites(f)).toEqual([]);
  });
});
