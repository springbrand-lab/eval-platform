import { and, eq, gt, lte, sql } from "drizzle-orm";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { equalJson, type AgentImportPreview } from "@eval-platform/eval-contracts";
import type { AgentImportQueue } from "../agent-import-queue.js";
import { ImportConflictError, ImportLeaseLostError } from "../agent-imports/errors.js";
import { digest, IMPORT_LIMITS, initialView, receiptSchema, type ImportTask, type PlannedResource } from "../agent-imports/model.js";
import type { AgentImportStore } from "../agent-imports/store.js";
import { createPostgresResourceSourceStore } from "./agent-import-sources.js";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { agentImportIntents, agentImportLeases, agentImportTaskIntents, agentImportTasks, resourceSources } from "./schema.js";

type Transaction = Parameters<Parameters<EvalDb["transaction"]>[0]>[0];
function taskRow(row: typeof agentImportTasks.$inferSelect): ImportTask {
  return { id: row.id, ownerUserId: row.ownerUserId, actorId: row.actorId, connectionId: row.connectionId,
    request: row.request, fingerprint: row.fingerprint, view: row.view, snapshot: row.snapshot, plan: row.plan,
    expiresAt: row.expiresAt.toISOString(), applyKey: row.applyKey, leaseToken: row.leaseToken,
    revision: row.revision, attempts: row.attempts };
}
const identity = (owner: string, kind: PlannedResource["kind"], id: string) => and(
  eq(agentImportIntents.ownerUserId, owner), eq(agentImportIntents.kind, kind), eq(agentImportIntents.id, id),
);

/** The same owner-scoped persisted task read, available without constructing the mutating store/queue. */
export function createPostgresAgentImportTaskReader(db: EvalDb, ownerUserId: string): Pick<AgentImportStore, "get"> {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    async get(id) {
      const [row] = await db.select().from(agentImportTasks).where(and(
        eq(agentImportTasks.ownerUserId, owner), eq(agentImportTasks.id, id),
      ));
      return row ? taskRow(row) : null;
    },
  };
}

/** All network/file I/O is outside these short transactions. Every worker write is fenced by its DB lease. */
export function createPostgresAgentImportStore(db: EvalDb, ownerUserId: string, queue: AgentImportQueue): AgentImportStore {
  const owner = requireOwnerUserId(ownerUserId);
  const scoped = (id: string) => and(eq(agentImportTasks.ownerUserId, owner), eq(agentImportTasks.id, id));
  async function assertLease(transaction: Transaction, task: ImportTask): Promise<void> {
    if (!task.leaseToken) throw new ImportLeaseLostError();
    const [current] = await transaction.select({ id: agentImportTasks.id }).from(agentImportTasks).where(and(
      scoped(task.id), eq(agentImportTasks.revision, task.revision), eq(agentImportTasks.leaseToken, task.leaseToken ?? ""),
      gt(agentImportTasks.leaseUntil, sql`now()`),
    )).for("update");
    const [lease] = await transaction.select().from(agentImportLeases).where(and(
      eq(agentImportLeases.ownerUserId, owner), eq(agentImportLeases.token, task.leaseToken ?? ""),
      eq(agentImportLeases.taskId, task.id), gt(agentImportLeases.expiresAt, sql`now()`),
    ));
    if (!current || !lease || task.ownerUserId !== owner) throw new ImportLeaseLostError();
  }
  async function createIntent(transaction: Transaction, task: ImportTask, resource: PlannedResource) {
    if (resource.platform) return;
    const values = {
      ownerUserId: owner, kind: resource.kind, id: resource.id, connectionId: task.connectionId,
      sourceUserId: task.request.sourceUserId, sourceDigest: resource.sourceDigest, targetDigest: resource.targetDigest,
      importKey: resource.importKey, fingerprint: digest({ connection: task.connectionId, user: task.request.sourceUserId,
        kind: resource.kind, id: resource.id, source: resource.sourceDigest, target: resource.targetDigest }),
      resource, status: "planned" as const,
    };
    await transaction.insert(agentImportIntents).values(values).onConflictDoNothing();
    const [current] = await transaction.select().from(agentImportIntents).where(identity(owner, resource.kind, resource.id));
    if (!current || current.fingerprint !== values.fingerprint || current.importKey !== values.importKey) {
      throw new ImportConflictError("A different or uncertain import already owns this target resource intent");
    }
    await transaction.insert(agentImportTaskIntents).values({ ownerUserId: owner, taskId: task.id, kind: resource.kind, id: resource.id }).onConflictDoNothing();
  }
  const store: AgentImportStore = {
    sources: createPostgresResourceSourceStore(db, owner),
    ...createPostgresAgentImportTaskReader(db, owner),
    async create(request: AgentImportPreview, connectionId, actorId) {
      const fingerprint = digest({ version: 1, owner, connectionId, sourceUserId: request.sourceUserId,
        agentIds: [...request.agentIds].sort(), purpose: request.purpose });
      return db.transaction(async (transaction) => {
        const id = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + IMPORT_LIMITS.ttlMs);
        const inserted = await transaction.insert(agentImportTasks).values({
          id, ownerUserId: owner, actorId: actorId ?? null, connectionId, sourceUserId: request.sourceUserId,
          requestKey: request.idempotencyKey, fingerprint, request, status: "checking",
          view: initialView(id, request, expiresAt.toISOString()), expiresAt,
        }).onConflictDoNothing().returning();
        const row = inserted[0] ?? (await transaction.select().from(agentImportTasks).where(and(
          eq(agentImportTasks.ownerUserId, owner), eq(agentImportTasks.requestKey, request.idempotencyKey),
        )))[0];
        if (!row || row.fingerprint !== fingerprint) throw new ImportConflictError("Idempotency key was used for a different import preview");
        if (inserted.length > 0) await queue.enqueue(transaction, row.id, "preview");
        return taskRow(row);
      });
    },
    async apply(id, key) {
      return db.transaction(async (transaction) => {
        const [row] = await transaction.select().from(agentImportTasks).where(scoped(id)).for("update");
        if (!row) throw new HttpError("REQUEST_NOT_FOUND", "Import task not found");
        if (!row.plan) throw new ImportConflictError("Import preview is not ready");
        const fingerprint = digest({ taskId: id, owner, connection: row.connectionId, user: row.sourceUserId,
          purpose: row.request.purpose, planDigest: row.plan.digest });
        if (row.applyKey !== null && (row.applyKey !== key || row.applyFingerprint !== fingerprint)) {
          throw new ImportConflictError("Idempotency key does not match this task's fixed apply request");
        }
        if (["completed", "completed_with_errors"].includes(row.status)) return taskRow(row);
        if (row.applyKey !== null && (row.status === "queued" || row.status === "importing"
          || row.leaseUntil && row.leaseUntil > new Date())) return taskRow(row);
        if (row.applyKey === null && row.status !== "ready") throw new ImportConflictError("Import preview is not ready");
        if (row.expiresAt <= new Date() && row.applyKey === null) throw new ImportConflictError("Import preview has expired; check again");
        const task = taskRow(row);
        // Persist every resource intent and task membership before the consumer can send a POST.
        const needed = new Set(row.plan.eligibleAgentIds.flatMap((agentId) => {
          const source = row.plan!.snapshot.agents.find((item) => item.id === agentId)!;
          return [`agent:${agentId}`, ...(Array.isArray(source.setting.skillIds) ? source.setting.skillIds.map((id) => `skill:${id}`) : []),
            ...(Array.isArray(source.setting.referenceFileIds) ? source.setting.referenceFileIds.map((id) => `reference:${id}`) : [])];
        }));
        for (const resource of row.plan.resources) if (needed.has(`${resource.kind}:${resource.id}`)) await createIntent(transaction, task, resource);
        const view = { ...row.view, status: "queued" as const, progress: { ...row.view.progress, stage: "queued" } };
        const [updated] = await transaction.update(agentImportTasks).set({
          status: "queued", view, applyKey: key, applyFingerprint: fingerprint, revision: row.revision + 1,
        }).where(scoped(id)).returning();
        await queue.enqueue(transaction, id, "apply");
        return taskRow(updated!);
      });
    },
    async claim(id, token) {
      return db.transaction(async (transaction) => {
        const [row] = await transaction.select().from(agentImportTasks).where(scoped(id)).for("update");
        if (!row || !["checking", "queued", "importing", "outcome_unknown"].includes(row.status)) return null;
        if (row.leaseUntil && row.leaseUntil > new Date()) throw new ImportLeaseLostError();
        const expiresAt = new Date(Date.now() + IMPORT_LIMITS.leaseMs);
        const leases = await transaction.insert(agentImportLeases).values({ ownerUserId: owner, taskId: id, token, expiresAt })
          .onConflictDoUpdate({ target: agentImportLeases.ownerUserId, set: { taskId: id, token, expiresAt },
            setWhere: lte(agentImportLeases.expiresAt, sql`now()`) }).returning();
        if (!leases[0]) throw new ImportLeaseLostError(); // queue retry, not a lost wake-up
        const [updated] = await transaction.update(agentImportTasks).set({
          leaseToken: token, leaseUntil: expiresAt, revision: row.revision + 1, attempts: row.attempts + 1,
        }).where(scoped(id)).returning();
        return taskRow(updated!);
      });
    },
    async heartbeat(task) {
      await db.transaction(async (transaction) => {
        await assertLease(transaction, task);
        const expiresAt = new Date(Date.now() + IMPORT_LIMITS.leaseMs);
        await transaction.update(agentImportTasks).set({ leaseUntil: expiresAt }).where(scoped(task.id));
        await transaction.update(agentImportLeases).set({ expiresAt }).where(and(eq(agentImportLeases.ownerUserId, owner), eq(agentImportLeases.token, task.leaseToken!)));
      });
    },
    async save(task, update) {
      await db.transaction(async (transaction) => {
        await assertLease(transaction, task);
        await transaction.update(agentImportTasks).set({
          ...update, ...(update.view === undefined ? {} : { status: update.view.status }), revision: task.revision + 1,
        }).where(scoped(task.id));
      });
      Object.assign(task, update, { revision: task.revision + 1 });
    },
    async release(task) {
      await db.transaction(async (transaction) => {
        await transaction.update(agentImportTasks).set({ leaseToken: null, leaseUntil: null }).where(and(scoped(task.id),
          eq(agentImportTasks.leaseToken, task.leaseToken ?? "")));
        await transaction.delete(agentImportLeases).where(and(eq(agentImportLeases.ownerUserId, owner), eq(agentImportLeases.token, task.leaseToken ?? "")));
      });
    },
    async intent(kind, id) {
      const [row] = await db.select().from(agentImportIntents).where(identity(owner, kind, id));
      return row ? { ...row.resource, ownerUserId: owner, connectionId: row.connectionId, sourceUserId: row.sourceUserId,
        status: row.status, receipt: row.receipt, attachment: row.attachment } : null;
    },
    async saveAttachment(task, resource, attachment) {
      await db.transaction(async (transaction) => {
        await assertLease(transaction, task);
        const [current] = await transaction.select().from(agentImportIntents).where(identity(owner, resource.kind, resource.id)).for("update");
        if (!current || current.importKey !== resource.importKey || resource.kind !== "reference") throw new ImportConflictError("Attachment has no matching Reference intent");
        if (current.attachment && !equalJson(current.attachment, attachment)) throw new ImportConflictError("Frozen target attachment changed");
        await transaction.update(agentImportIntents).set({ attachment }).where(identity(owner, resource.kind, resource.id));
      });
    },
    async markIntent(task, resource, status, receipt, error) {
      await db.transaction(async (transaction) => {
        await assertLease(transaction, task);
        await createIntent(transaction, task, resource);
        const [current] = await transaction.select().from(agentImportIntents).where(identity(owner, resource.kind, resource.id)).for("update");
        if (current?.receipt && receipt && !equalJson(current.receipt, receipt)) throw new ImportConflictError("Target receipt changed");
        if (receipt) {
          const valid = receiptSchema.parse(receipt);
          if (valid.resourceKind !== resource.kind || valid.resourceId !== resource.id || valid.importKey !== resource.importKey) {
            throw new ImportConflictError("Target receipt does not match the persisted intent");
          }
        }
        await transaction.update(agentImportIntents).set({
          status, ...(receipt === undefined ? {} : { receipt }), ...(error === undefined ? {} : { error }),
        }).where(identity(owner, resource.kind, resource.id));
      });
    },
    async complete(task, resource, receipt) {
      await db.transaction(async (transaction) => {
        await assertLease(transaction, task);
        if (!resource.platform && !receipt) throw new ImportConflictError("Import completion needs a proven target receipt");
        const values = { ownerUserId: owner, kind: resource.kind, id: resource.id,
          origin: resource.platform ? "platform_catalog" as const : "dev_import" as const,
          connectionId: task.connectionId, sourceUserId: task.request.sourceUserId,
          sourceDigest: resource.sourceDigest, targetDigest: resource.targetDigest, receipt };
        await transaction.insert(resourceSources).values(values).onConflictDoNothing();
        const [current] = await transaction.select().from(resourceSources).where(and(
          eq(resourceSources.ownerUserId, owner), eq(resourceSources.kind, resource.kind), eq(resourceSources.id, resource.id),
        ));
        if (!current || current.origin !== values.origin || current.connectionId !== values.connectionId
          || !resource.platform && current.sourceUserId !== values.sourceUserId || current.sourceDigest !== values.sourceDigest
          || current.targetDigest !== values.targetDigest || !equalJson(current.receipt, receipt)) {
          throw new ImportConflictError("Existing target provenance cannot be replaced or claimed");
        }
        if (!resource.platform) {
          const [intent] = await transaction.select().from(agentImportIntents).where(identity(owner, resource.kind, resource.id)).for("update");
          if (!intent || intent.importKey !== resource.importKey || !equalJson(intent.receipt, receipt)) throw new ImportConflictError("Completion does not match the durable intent");
          await transaction.update(agentImportIntents).set({ status: "completed", error: null }).where(identity(owner, resource.kind, resource.id));
        }
      });
    },
  };
  return store;
}
