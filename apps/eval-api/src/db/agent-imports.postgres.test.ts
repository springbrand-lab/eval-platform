import { sql, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import type { AgentImportQueue } from "../agent-import-queue.js";
import { AGENT_IMPORT_QUEUE, AGENT_IMPORT_QUEUE_OPTIONS, createAgentImportQueue, type AgentImportJob } from "../agent-import-queue.js";
import { ImportConflictError, ImportLeaseLostError } from "../agent-imports/errors.js";
import { digest, type ImportPlan, type ImportTask, type PlannedResource } from "../agent-imports/model.js";
import { planDigest, resourceDigests } from "../agent-imports/semantics.js";
import { createPostgresAgentImportStore } from "./agent-imports.js";
import { agentImportIntents, agentImportLeases, agentImportTasks, resourceSources } from "./schema.js";
import { createTestDatabase } from "./test-database.js";

// Dedicated opt-in only. Never discover a URL from .env or borrow a service/production database.
const connection = process.env.EVAL_IMPORT_TEST_DATABASE_URL;
const owner = "11111111-1111-4111-8111-111111111111";
const sourceUser = "22222222-2222-4222-8222-222222222222";

describe.skipIf(!connection)("Agent import PostgreSQL transactions, ownership and lease fencing (requires EVAL_IMPORT_TEST_DATABASE_URL)", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let failEnqueue = false;
  const queue: AgentImportQueue = { async enqueue(transaction, taskId) {
    await transaction.execute(sql`INSERT INTO import_job_probe (task_id) VALUES (${taskId})`);
    if (failEnqueue) throw new Error("queue insert failure");
  } };
  beforeAll(async () => {
    database = await createTestDatabase(connection!);
    await database.db.execute(sql`CREATE TABLE import_job_probe (task_id uuid NOT NULL)`);
  }, 30_000);
  afterAll(async () => { if (database) await database.destroy(); }, 30_000);
  const store = (id = owner) => createPostgresAgentImportStore(database.db, id, queue);
  const request = () => ({ sourceUserId: sourceUser, agentIds: [crypto.randomUUID()], purpose: "execution" as const, idempotencyKey: crypto.randomUUID() });
  async function ready(currentStore = store(), beforeReady?: () => Promise<void>): Promise<{ task: ImportTask; resource: PlannedResource }> {
    const current = await currentStore.create(request(), "fixed-connection");
    const claimed = (await currentStore.claim(current.id, crypto.randomUUID()))!;
    await beforeReady?.();
    const source = { id: current.request.agentIds[0]!, name: "A", description: null, slug: "source", revision: 1, setting: {} };
    const resource: PlannedResource = { kind: "agent", id: source.id, name: "A", source, files: [],
      sourceDigest: "", targetDigest: "", importKey: "", prepared: {
        purpose: "execution", evaluationMcpServerId: null, dependencies: [],
        config: { id: source.id, name: "A", description: null, slug: `import-${source.id}`, setting: {} },
      } };
    resourceDigests(resource, claimed);
    const plan: ImportPlan = { version: 1, snapshot: { version: 1, sourceUserId: sourceUser, agents: [source], skills: [], references: [], dependencies: [] },
      resources: [resource], eligibleAgentIds: [source.id], digest: "" };
    plan.digest = planDigest(plan, claimed);
    await currentStore.save(claimed, { plan, snapshot: plan.snapshot, view: { ...claimed.view, status: "ready",
      agents: claimed.view.agents.map((agent) => ({ ...agent, status: "ready" })) } });
    await currentStore.release(claimed);
    return { task: (await currentStore.get(current.id))!, resource };
  }

  it("commits task and enqueue together; same-key changed source user/purpose is rejected", async () => {
    const body = request();
    const first = await store().create(body, "connection");
    expect((await store().create(body, "connection")).id).toBe(first.id);
    await expect(store().create({ ...body, sourceUserId: owner }, "connection")).rejects.toBeInstanceOf(ImportConflictError);
    await expect(store().create({ ...body, purpose: "evaluation" }, "connection")).rejects.toBeInstanceOf(ImportConflictError);
    await expect(store().create(body, "different-connection")).rejects.toBeInstanceOf(ImportConflictError);
    const jobs = (await database.db.execute(sql`SELECT * FROM import_job_probe WHERE task_id = ${first.id}`)).rows;
    expect(jobs).toHaveLength(1);
    failEnqueue = true;
    const rejected = request();
    await expect(store().create(rejected, "connection")).rejects.toThrow("queue insert failure");
    failEnqueue = false;
    expect(await database.db.select().from(agentImportTasks).where(eq(agentImportTasks.requestKey, rejected.idempotencyKey))).toHaveLength(0);
  });

  it("binds all data to the fixed target owner, not the chosen source user or audit actor", async () => {
    const first = await store().create(request(), "connection", "actor");
    expect(first).toMatchObject({ ownerUserId: owner, actorId: "actor", request: { sourceUserId: sourceUser } });
    expect(await store(sourceUser).get(first.id)).toBeNull();
    expect(await store("another-owner").get(first.id)).toBeNull();
    const other = await store("another-owner").create(first.request, "connection");
    expect(other.id).not.toBe(first.id);
  });

  it("atomically persists immutable resource intents, task apply key and enqueue, with rollback on queue failure", async () => {
    const { task, resource } = await ready();
    failEnqueue = true;
    await expect(store().apply(task.id, "apply")).rejects.toThrow("queue insert failure");
    failEnqueue = false;
    expect((await store().get(task.id))?.applyKey).toBeNull();
    expect(await store().intent("agent", resource.id)).toBeNull();
    const applied = await store().apply(task.id, "apply");
    expect(applied.view.status).toBe("queued");
    expect(await store().intent("agent", resource.id)).toMatchObject({ status: "planned", importKey: resource.importKey, receipt: null });
    await expect(store().apply(task.id, "other-key")).rejects.toBeInstanceOf(ImportConflictError);
    const before = (await store().get(task.id))!.revision;
    await store().apply(task.id, "apply");
    expect((await store().get(task.id))?.revision).toBe(before);
  });

  it("does not lose apply behind an active preview in real pg-boss exclusive, and rolls back a rejected wake-up", async () => {
    // Only runs in this suite's explicitly opted-in temporary database; no Worker, SP or real import.
    const boss = new PgBoss({ connectionString: database.connectionString, schedule: false, supervise: false });
    try {
      await boss.start();
      await boss.createQueue(AGENT_IMPORT_QUEUE, AGENT_IMPORT_QUEUE_OPTIONS);
      const currentStore = createPostgresAgentImportStore(database.db, owner, createAgentImportQueue(boss));
      let preview: JobWithMetadata<AgentImportJob> | undefined;
      const { task, resource } = await ready(currentStore, async () => {
        [preview] = await boss.fetch<AgentImportJob>(AGENT_IMPORT_QUEUE, { includeMetadata: true });
        expect(preview?.state).toBe("active");
      }); // ready is committed, preview delivery is still active and unacknowledged
      expect(preview?.singletonKey).toBe(`preview:${task.id}`);
      const blocker = await boss.send(AGENT_IMPORT_QUEUE, { taskId: task.id }, { singletonKey: `apply:${task.id}` });
      expect(blocker).not.toBeNull();
      await expect(currentStore.apply(task.id, "same-apply-key")).rejects.toThrow(/wake-up/i);
      expect(await currentStore.get(task.id)).toMatchObject({ applyKey: null, view: { status: "ready" } });
      expect(await currentStore.intent("agent", resource.id)).toBeNull(); // queued + intents rolled back with null send
      const [blocked] = await boss.fetch<AgentImportJob>(AGENT_IMPORT_QUEUE);
      expect(blocked?.id).toBe(blocker);
      await boss.complete(AGENT_IMPORT_QUEUE, blocked!.id);
      const applied = await currentStore.apply(task.id, "same-apply-key");
      expect(applied.view.status).toBe("queued");
      expect((await boss.getJobById(AGENT_IMPORT_QUEUE, preview!.id))?.state).toBe("active");
      await boss.complete(AGENT_IMPORT_QUEUE, preview!.id); // late preview ACK cannot settle the apply delivery
      await currentStore.apply(task.id, "same-apply-key"); // queued replay does not allocate another wake-up
      const [apply] = await boss.fetch<AgentImportJob>(AGENT_IMPORT_QUEUE, { includeMetadata: true });
      expect(apply).toMatchObject({ data: { taskId: task.id }, singletonKey: `apply:${task.id}`, state: "active" });
      expect(apply!.id).not.toBe(preview!.id);
      expect(await boss.fetch(AGENT_IMPORT_QUEUE)).toEqual([]);
      await boss.complete(AGENT_IMPORT_QUEUE, apply!.id);
    } finally { await boss.stop(); }
  }, 30_000);

  it("retries busy duplicate deliveries, reclaims expired owner leases, and rejects stale CAS writers without network locks", async () => {
    const first = await store().create(request(), "connection");
    const second = await store().create(request(), "connection");
    const old = (await store().claim(first.id, crypto.randomUUID()))!;
    await expect(store().claim(first.id, crypto.randomUUID())).rejects.toBeInstanceOf(ImportLeaseLostError);
    await expect(store().claim(second.id, crypto.randomUUID())).rejects.toBeInstanceOf(ImportLeaseLostError);
    expect(await store().get(second.id)).not.toBeNull(); // reads are not blocked by a held transaction
    await database.db.update(agentImportTasks).set({ leaseUntil: new Date(0) }).where(eq(agentImportTasks.id, first.id));
    await database.db.update(agentImportLeases).set({ expiresAt: new Date(0) }).where(eq(agentImportLeases.ownerUserId, owner));
    const current = (await store().claim(first.id, crypto.randomUUID()))!;
    await expect(store().save(old, { view: { ...old.view, status: "failed" } })).rejects.toBeInstanceOf(ImportLeaseLostError);
    await store().save(current, { view: { ...current.view, status: "ready" } });
    await store().release(current);
  });

  it("requires actual matching receipts to register source or hide a new unfinished Agent; native rows are never adopted", async () => {
    const { task, resource } = await ready();
    await store().apply(task.id, "apply");
    const claimed = (await store().claim(task.id, crypto.randomUUID()))!;
    await store().markIntent(claimed, resource, "submitting");
    expect(await store().sources.pendingAgentIds([resource.id])).toEqual(new Set());
    expect(await store().sources.get("agent", resource.id)).toBeNull();
    const receipt = { id: crypto.randomUUID(), resourceKind: "agent" as const, resourceId: resource.id,
      importKey: resource.importKey, fingerprint: digest(resource.prepared), createdAt: new Date().toISOString() };
    await expect(store().complete(claimed, resource, receipt)).rejects.toBeInstanceOf(ImportConflictError);
    await store().markIntent(claimed, resource, "confirmed", receipt);
    expect(await store().sources.pendingAgentIds([resource.id])).toEqual(new Set([resource.id]));
    await store().sources.recordNative(resource.id);
    expect(await store().sources.pendingAgentIds([resource.id])).toEqual(new Set());
    await expect(store().complete(claimed, resource, receipt)).rejects.toBeInstanceOf(ImportConflictError);
    expect(await store().sources.get("agent", resource.id)).toMatchObject({ origin: "eval_native" });
    expect((await database.db.select().from(resourceSources).where(eq(resourceSources.id, resource.id)))[0]?.sourceUserId).toBeNull();
    expect((await database.db.select().from(agentImportIntents).where(eq(agentImportIntents.id, resource.id)))[0]?.receipt).toEqual(receipt);
    await store().release(claimed);
  });
});
