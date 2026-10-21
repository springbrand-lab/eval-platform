import { AGENT_IMPORT_MAX_AGENTS, agentImportPreviewSchema, type AgentImportCandidatePage } from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { ImportDependencyError } from "./errors.js";
import type { AgentImportSource } from "./source.js";
import type { AgentImportStore } from "./store.js";
import type { AgentImportTarget } from "./target.js";

/** Durable owner-scoped reads do not depend on a live source, target capability or queue. */
export function createAgentImportTaskReader(store: Pick<AgentImportStore, "get">) {
  return {
    async task(taskId: string) {
      const task = await store.get(taskId);
      if (!task) throw new HttpError("REQUEST_NOT_FOUND", "Import task not found");
      return task.view; // never spread the internal task, source metadata, plan or receipts
    },
  };
}
export type AgentImportTaskReader = ReturnType<typeof createAgentImportTaskReader>;

export function createAgentImportService(input: { source: AgentImportSource; target: AgentImportTarget; store: AgentImportStore }) {
  const { source, target, store } = input;
  return {
    config: async () => ({ enabled: (await target.config()).enabled, maxAgents: AGENT_IMPORT_MAX_AGENTS }),
    users: (query: { q?: string | undefined; limit?: number | undefined }) =>
      source.users({ ...(query.q === undefined ? {} : { q: query.q }), ...(query.limit === undefined ? {} : { limit: query.limit }) }),
    async candidates(sourceUserId: string, query: { q?: string | undefined; cursor?: string | undefined; limit?: number | undefined; onlyMissing?: boolean | undefined }): Promise<AgentImportCandidatePage> {
      const { onlyMissing, ...scope } = query;
      const [page, existing] = await Promise.all([source.agents(sourceUserId, {
        ...(scope.q === undefined ? {} : { q: scope.q }), ...(scope.cursor === undefined ? {} : { cursor: scope.cursor }),
        ...(scope.limit === undefined ? {} : { limit: scope.limit }),
      }), target.listAgents()]);
      const ids = new Set(existing.filter((agent) => agent.user_id === target.ownerUserId).map((agent) => agent.id));
      const items = page.items.map((item) => ({ ...item, description: item.description ?? "", exists: ids.has(item.id) }));
      // Preserve the SOURCE cursor even when an entire page is filtered; an empty page is not end-of-scope.
      return { items: onlyMissing ? items.filter((item) => !item.exists) : items, nextCursor: page.nextCursor };
    },
    async preview(body: unknown, actorId?: string) {
      const request = agentImportPreviewSchema.parse(body);
      await target.requireEnabled();
      const task = await store.create(request, source.connectionId, actorId);
      return { taskId: task.id };
    },
    async apply(taskId: string, key: string) {
      await target.requireEnabled();
      const task = await store.apply(taskId, key);
      return { taskId: task.id };
    },
  };
}
export type AgentImportService = ReturnType<typeof createAgentImportService>;
export function requireAgentImports(service: AgentImportService | undefined): AgentImportService {
  if (!service) throw new ImportDependencyError("Agent imports are disabled; no authorized dev source is configured");
  return service;
}
