import type { AgentPurpose } from "@eval-platform/eval-contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { EvalDb } from "./client.js";
import { agentConfigPurposes } from "./schema.js";
import { requireOwnerUserId } from "./owner.js";

export interface AgentPurposeRecord {
  readonly userAgentId: string;
  readonly purpose: AgentPurpose;
  readonly evaluationMcpServerId: string | null;
}

export interface AgentPurposeInput {
  readonly userAgentId: string;
  readonly purpose: AgentPurpose;
  readonly evaluationMcpServerId: string | null;
}

export interface AgentPurposeStore {
  list(userAgentIds: readonly string[]): Promise<readonly AgentPurposeRecord[]>;
  get(userAgentId: string): Promise<AgentPurposeRecord | null>;
  ensure(input: AgentPurposeInput): Promise<AgentPurposeRecord>;
  upsert(input: AgentPurposeInput): Promise<AgentPurposeRecord>;
  remove(userAgentId: string): Promise<void>;
}

function record(row: typeof agentConfigPurposes.$inferSelect): AgentPurposeRecord {
  return {
    userAgentId: row.userAgentId,
    purpose: row.purpose,
    evaluationMcpServerId: row.evaluationMcpServerId,
  };
}

/** Owner-scoped persistence for the current purpose metadata of editable SP Agent Configs. */
export function createPostgresAgentPurposeStore(db: EvalDb, ownerUserId: string): AgentPurposeStore {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    async list(userAgentIds) {
      if (userAgentIds.length === 0) return [];
      const rows = await db.select().from(agentConfigPurposes).where(and(
        eq(agentConfigPurposes.ownerUserId, owner), inArray(agentConfigPurposes.userAgentId, userAgentIds),
      ));
      return rows.map(record);
    },
    async get(userAgentId) {
      const [row] = await db.select().from(agentConfigPurposes).where(and(
        eq(agentConfigPurposes.ownerUserId, owner), eq(agentConfigPurposes.userAgentId, userAgentId),
      ));
      return row ? record(row) : null;
    },
    async ensure(input) {
      await db.insert(agentConfigPurposes).values({ ownerUserId: owner, ...input }).onConflictDoNothing();
      const current = await this.get(input.userAgentId);
      if (!current) throw new Error(`Agent purpose ${input.userAgentId} was not persisted`);
      return current;
    },
    async upsert(input) {
      await db.insert(agentConfigPurposes).values({ ownerUserId: owner, ...input }).onConflictDoUpdate({
        target: [agentConfigPurposes.ownerUserId, agentConfigPurposes.userAgentId],
        set: { purpose: input.purpose, evaluationMcpServerId: input.evaluationMcpServerId },
      });
      const current = await this.get(input.userAgentId);
      if (!current) throw new Error(`Agent purpose ${input.userAgentId} was not persisted`);
      return current;
    },
    async remove(userAgentId) {
      await db.delete(agentConfigPurposes).where(and(
        eq(agentConfigPurposes.ownerUserId, owner), eq(agentConfigPurposes.userAgentId, userAgentId),
      ));
    },
  };
}
