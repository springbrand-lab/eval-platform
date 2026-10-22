import { z } from "zod";
import { agentImportSourceUserIdSchema, agentImportSourceUserPageSchema, type AgentImportSourceUserPage } from "@eval-platform/eval-contracts";
import { createSpHttpClient, throwSpClientError, type Fetch } from "../sp/http.js";
import { importOriginSchema } from "../config/agent-imports.js";
import { connectionId, sourceSnapshotSchema, uuid, type SourceSnapshot } from "./model.js";
import { dependencyFailure } from "./errors.js";
import { requireDefinitionScope } from "./definition-evidence.js";

const querySchema = z.strictObject({
  q: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().max(2000).optional(),
});
const usersQuerySchema = querySchema.extend({
  q: z.string().trim().max(200).default(""),
  limit: z.number().int().min(1).max(20).default(20),
  cursor: z.string().min(1).max(4096).optional(),
});
const candidatesSchema = z.object({
  items: z.array(z.object({
    id: uuid, name: z.string(), description: z.string().nullable(), revision: z.number().int().nonnegative(),
    skillCount: z.number().int().nonnegative(), referenceCount: z.number().int().nonnegative(),
  })).max(50),
  nextCursor: z.string().nullable(),
});
export type SourceCandidatePage = z.infer<typeof candidatesSchema>;
export interface AgentImportSource {
  readonly origin: string;
  readonly connectionId: string;
  users(query: { q?: string; cursor?: string; limit?: number }): Promise<AgentImportSourceUserPage>;
  agents(sourceUserId: string, query: { q?: string; cursor?: string; limit?: number }): Promise<SourceCandidatePage>;
  snapshot(sourceUserId: string, agentIds: readonly string[]): Promise<SourceSnapshot>;
}

/** Deliberately no generic request, share, session, upload, mutation or arbitrary-path capability. */
export function createAgentImportSource(input: { origin: string; targetOrigin: string; token: string; fetch?: Fetch }): AgentImportSource {
  const origin = importOriginSchema.parse(input.origin);
  if (origin === importOriginSchema.parse(input.targetOrigin)) throw new TypeError("source and target origins must differ");
  if (!input.token.trim()) throw new TypeError("Export token is required");
  const http = createSpHttpClient({
    origin, responseMode: "envelope", timeoutMs: 60_000, maxResponseBytes: 16 * 1024 * 1024, fetch: input.fetch,
    headers: { Authorization: `Bearer ${input.token}` },
  });
  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    try {
      const result = await http.request(path, { method: "GET" });
      return schema.parse(result.data);
    } catch (error) {
      try { throwSpClientError(error); } catch (cause) { dependencyFailure(cause); }
    }
  }
  function query(input: z.output<typeof querySchema>): string {
    return new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)])).toString();
  }
  return {
    origin, connectionId: connectionId(origin),
    async users(input) {
      return get(`/api/agent-config-export/users?${query(usersQuerySchema.parse(input))}`,
        agentImportSourceUserPageSchema);
    },
    agents(id, input) {
      return get(`/api/agent-config-export/users/${encodeURIComponent(agentImportSourceUserIdSchema.parse(id))}/agents?${query(querySchema.parse({ ...input, limit: input.limit ?? 20 }))}`, candidatesSchema);
    },
    async snapshot(id, agentIds) {
      const user = agentImportSourceUserIdSchema.parse(id);
      const ids = z.array(uuid).min(1).max(50).parse(agentIds);
      if (new Set(ids).size !== ids.length) throw new TypeError("Duplicate selected Agent IDs");
      const snapshot = await get(`/api/agent-config-export/users/${encodeURIComponent(user)}/snapshot?${new URLSearchParams({ agentIds: ids.join(",") })}`, sourceSnapshotSchema);
      if (snapshot.sourceUserId !== user || snapshot.agents.length !== ids.length ||
        new Set(snapshot.agents.map((agent) => agent.id)).size !== ids.length ||
        snapshot.agents.some((agent) => !ids.includes(agent.id))) dependencyFailure(new Error("Export scope mismatch"));
      try { requireDefinitionScope(snapshot.agents, snapshot.dependencies); } catch (cause) { dependencyFailure(cause); }
      return snapshot;
    },
  };
}
