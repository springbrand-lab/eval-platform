import { afterEach, describe, expect, it } from "vitest";
import { ImportConflictError, ImportDependencyError } from "./errors.js";
import { digest, resourceKey, type SourceSnapshot } from "./model.js";
import { agentId, otherAgentId, snapshotFixture, workerFixture } from "./worker.test-support.js";

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
  request.method === "POST" && new URL(request.url).pathname !== "/api/agent-config-imports/dependencies");
const probes = (f: Awaited<ReturnType<typeof workerFixture>>) => f.requests.filter((request) =>
  new URL(request.url).pathname === "/api/agent-config-imports/dependencies");

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
  let responseItems: Evidence[] | undefined;
  const fetch = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/api/agent-config-imports/dependencies") {
      f.requests.push(request.clone());
      expect(request.method).toBe("POST");
      expect(request.headers.get("Authorization")).toBe("Bearer target-session");
      expect(request.headers.get("Origin")).toBe("https://web.test");
      const body = await request.json() as { resources: Omit<Evidence, "fingerprint">[] };
      expect(Object.keys(body)).toEqual(["resources"]);
      expect(body.resources.length).toBeLessThanOrEqual(500);
      expect(body.resources.every((item) => Object.keys(item).sort().join(",") === "id,kind")).toBe(true);
      if (status !== 200) return status === 409 ? conflict() : Response.json({ code: "AUTH_UNAUTHENTICATED", errMsg: "private upstream" }, { status });
      const items = body.resources.map((item) => targetProofs.find((proof) => proof.kind === item.kind && proof.id === item.id));
      if (items.some((item) => !item)) return conflict();
      return ok({ items: responseItems ?? items.reverse() }); // wire ordering is not a definition version
    }
    if (url.pathname.startsWith("/api/actions/")) {
      f.requests.push(request.clone());
      return ok({ id: decodeURIComponent(url.pathname.split("/").at(-1)!), name: "Action", description: "", status: "active", selectable: true, supplier: null });
    }
    if (url.pathname === "/api/components") {
      f.requests.push(request.clone());
      const kind = url.searchParams.get("kind");
      return ok({ data: [{ id: `${kind}-selected`, kind, name: "Component", description: "", status: "active", selectable: true }],
        total: 1, page: 1, pageSize: 100 });
    }
    return fetch(request);
  });
  return { ...f, targetProofs, setStatus: (value: number) => { status = value; },
    setResponseItems: (value: Evidence[]) => { responseItems = value; } };
}

describe("selected public capability definition evidence", () => {
  it("freezes source proofs into both digests/import keys and sends exactly those proofs on the Agent POST", async () => {
    const snapshot = snapshotWithSelections();
    const f = await fixture(snapshot);
    const task = await f.preview();
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["ready", "ready"]);
    expect(resourceWrites(f)).toEqual([]);
    expect(probes(f)).toHaveLength(1);
    expect(await probes(f)[0]!.clone().json()).toEqual({ resources: sortedProofs.map(({ kind, id }) => ({ kind, id })) });
    const resource = task.plan!.resources.find((resource) => resource.kind === "agent" && resource.id === agentId)!;
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
    expect(probes(f)).toEqual([]);
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect([...f.targetAgents.keys()]).toEqual([otherAgentId]);
    expect(resourceWrites(f).map((request) => new URL(request.url).pathname)).toEqual(["/api/user-agent-configs/imports"]);
  });

  it("blocks duplicate source kind/ID proofs only in their root rather than selecting an arbitrary version", async () => {
    const snapshot = snapshotWithSelections([...structuredClone(proofs), { ...proofs[1]!, fingerprint: "b".repeat(64) }]);
    const f = await fixture(snapshot);
    const task = await f.preview();
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["conflict", "ready"]);
    expect(probes(f)).toEqual([]);
    expect(resourceWrites(f)).toEqual([]);
  });

  it.each(["different-version", "unavailable"] as const)("rejects a same-ID %s target definition during preview without publication/adoption", async (change) => {
    const f = await fixture();
    if (change === "different-version") f.targetProofs[1]!.fingerprint = "b".repeat(64);
    else f.setStatus(409);
    const task = await f.preview();
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["conflict", "ready"]);
    expect(probes(f)).toHaveLength(1);
    await f.store.apply(task.id, "apply"); await f.worker.run(task.id);
    expect([...f.targetAgents.keys()]).toEqual([otherAgentId]);
    expect(resourceWrites(f).map((request) => new URL(request.url).pathname)).toEqual(["/api/user-agent-configs/imports"]);
  });

  it.each([
    [proofs[1]!, proofs[1]!, proofs[0]!],
    [proofs[1]!, proofs[2]!],
    [proofs[1]!, proofs[2]!, { ...proofs[0]!, kind: "action" as const }],
    [proofs[1]!, proofs[2]!, { ...proofs[0]!, id: "unselected" }],
  ])("rejects target proof coverage mismatch/duplicate instead of trusting ID selectable facts", async (...items) => {
    const f = await fixture();
    f.setResponseItems(items);
    const task = await f.preview();
    expect(task.view.agents.map((agent) => agent.status)).toEqual(["conflict", "ready"]);
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
    expect(f.requests.slice(before).some((request) => new URL(request.url).pathname === "/api/agent-config-imports/dependencies")).toBe(true);
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
    expect(task.view.status).toBe("outcome_unknown");
    expect(task.plan).toEqual(plan);
    f.setStatus(200);
    await f.worker.run(task.id);
    expect(task.view.status).toBe("completed");
    expect(task.plan).toEqual(plan);
  });

  it("guards the metadata POST with target import capability, without confusing it with a resource mutation", async () => {
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
