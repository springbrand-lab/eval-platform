import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { agentImportIntents, resourceSources } from "./schema.js";
import { receiptSchema, type ResourceKind, type ResourceSource } from "../agent-imports/model.js";
import { ImportConflictError } from "../agent-imports/errors.js";

export interface ResourceSourceStore {
  get(kind: ResourceKind, id: string): Promise<ResourceSource | null>;
  recordNative(id: string): Promise<void>;
  /** Only confirmed receipts, never unknown intents, can suppress an unfinished new Agent. */
  pendingAgentIds(ids: readonly string[]): Promise<ReadonlySet<string>>;
}
export function createPostgresResourceSourceStore(db: EvalDb, ownerUserId: string): ResourceSourceStore {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    async get(kind, id) {
      const [row] = await db.select().from(resourceSources).where(and(
        eq(resourceSources.ownerUserId, owner), eq(resourceSources.kind, kind), eq(resourceSources.id, id),
      ));
      return row ?? null;
    },
    async recordNative(id) {
      await db.insert(resourceSources).values({ ownerUserId: owner, kind: "agent", id, origin: "eval_native" }).onConflictDoNothing();
      const current = await this.get("agent", id);
      if (current?.origin !== "eval_native") throw new ImportConflictError("Agent already has a different proven source");
    },
    async pendingAgentIds(ids) {
      if (ids.length === 0) return new Set();
      const rows = await db.select({ id: agentImportIntents.id, key: agentImportIntents.importKey, receipt: agentImportIntents.receipt })
        .from(agentImportIntents).leftJoin(resourceSources, and(
          eq(resourceSources.ownerUserId, agentImportIntents.ownerUserId), eq(resourceSources.kind, "agent"),
          eq(resourceSources.id, agentImportIntents.id),
        )).where(and(
          eq(agentImportIntents.ownerUserId, owner), eq(agentImportIntents.kind, "agent"), inArray(agentImportIntents.id, [...ids]),
          eq(agentImportIntents.status, "confirmed"), or(isNull(resourceSources.origin), ne(resourceSources.origin, "eval_native")),
        ));
      return new Set(rows.flatMap((row) => {
        const parsed = receiptSchema.safeParse(row.receipt);
        return parsed.success && parsed.data.resourceKind === "agent" && parsed.data.resourceId === row.id
          && parsed.data.importKey === row.key ? [row.id] : [];
      }));
    },
  };
}
