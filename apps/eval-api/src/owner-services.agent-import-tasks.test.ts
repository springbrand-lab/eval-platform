import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { initialView } from "./agent-imports/model.js";
import { createAgentImportTarget } from "./agent-imports/target.js";
import type { EvalDb } from "./db/client.js";
import { agentConfigPurposes, agentImportTasks } from "./db/schema.js";
import type { ApiRuntime } from "./lib/types.js";
import { createOwnerServices } from "./owner-services.js";
import type { RunQueue } from "./run-worker-queue.js";
import type { BundleDirectory } from "./sp/bundle-directory.js";
import { createEvalSpClient } from "./sp/client.js";
import { jsonRequest, requestApp, WEB_ORIGIN } from "./test-support.js";

const owner = "11111111-1111-4111-8111-111111111111";
const otherOwner = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";
const agentId = "44444444-4444-4444-8444-444444444444";
const missingId = "55555555-5555-4555-8555-555555555555";
const request = { sourceUserId: otherOwner, agentIds: [agentId], purpose: "execution" as const, idempotencyKey: "preview" };
const ok = (msg: unknown, headers: HeadersInit = {}) => Response.json({ success: true, msg, errMsg: "", code: "" }, { headers });

/** Real routes + owner composition + SQL adapter. Only the database driver and HTTP are fake. */
function fixture(status: "queued" | "completed" | "outcome_unknown", withTarget = true, taskOwner = owner) {
  const view = { ...initialView(id, request, "2099-01-01T00:00:00.000Z"), status };
  const row = {
    id, ownerUserId: taskOwner, actorId: "audit", connectionId: "removed-source", request,
    fingerprint: "internal-fingerprint", view, snapshot: null, plan: null, applyKey: "apply",
    leaseToken: null, expiresAt: new Date(view.expiresAt!), revision: 2, attempts: 1,
  };
  const queries: { sql: string; params: unknown[] }[] = [];
  const inserts: unknown[] = [];
  let purpose: Record<string, unknown> | null = null;
  const transaction = vi.fn(async () => { throw new Error("Task read must not start a write transaction"); });
  const db = {
    transaction,
    select() {
      return { from(table: unknown) {
        if (table !== agentImportTasks && table !== agentConfigPurposes) throw new Error("Unexpected read");
        return { async where(condition: SQL) {
          const query = new PgDialect().sqlToQuery(condition);
          if (table === agentConfigPurposes) return purpose && query.params[0] === owner && query.params[1] === agentId ? [purpose] : [];
          queries.push(query);
          // Interpret the actual adapter's bound owner + task predicates, not the route's requested identity.
          expect(query.sql).toContain('"eval_agent_import_tasks"."owner_user_id" = $1');
          expect(query.sql).toContain('"eval_agent_import_tasks"."task_id" = $2');
          return query.params[0] === row.ownerUserId && query.params[1] === row.id ? [row] : [];
        } };
      } };
    },
    insert(table: unknown) {
      inserts.push(table);
      if (table !== agentConfigPurposes) throw new Error("Unexpected persistence mutation");
      return { values: (value: Record<string, unknown>) => ({ onConflictDoUpdate: async () => { purpose = value; } }) };
    },
  } as unknown as EvalDb;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    if (path === "/api/agent-config-imports/config") return ok({ version: 1, enabled: false });
    if (path === "/api/mcp-servers") return ok({ data: [], total: 0, page: 1, pageSize: 100 });
    if (path === "/api/user-agent-configs" && req.method === "POST") return ok({
      id: agentId, user_id: owner, name: "Native", slug: "native", description: null, setting: { mcpServers: [] },
    }, { "X-Agent-Config-Created": "false" });
    throw new Error(`No source/session/queue/import HTTP is permitted: ${req.method} ${path}`);
  });
  const sp = createEvalSpClient({ origin: "https://eval.test", writeOrigin: WEB_ORIGIN, fetch });
  const target = createAgentImportTarget({ origin: "https://eval.test", writeOrigin: WEB_ORIGIN, ownerUserId: owner,
    sessionToken: "fixed-session", sp, fetch });
  const ownerServices = createOwnerServices({
    db, sp, bundles: {} as BundleDirectory, runQueue: {} as RunQueue,
    release: { sourceBranch: "sp/eval", sourceCommit: "a".repeat(40) },
    ...(withTarget ? { agentImportTarget: target } : {}),
    // Deliberately no source or import queue.
  });
  const runtime = { webOrigin: WEB_ORIGIN, sp, ownerServices,
    serviceAccount: { user: { id: owner, role: "user" }, email: "service@example.test", sessionToken: "fixed-session" },
  } as unknown as ApiRuntime;
  return { request: requestApp(runtime), view, fetch, queries, inserts, transaction };
}

describe("persisted import tasks with optional imports removed, through real owner composition", () => {
  for (const withTarget of [false, true]) {
    it.each(["queued", "completed", "outcome_unknown"] as const)(`reads %s with no source, target configured=${withTarget}, without any remote or queue calls`, async (status) => {
      const f = fixture(status, withTarget);
      const response = await f.request(`/api/agent-config-sync/tasks/${id}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, msg: f.view, code: "", errMsg: "" });
      expect(f.queries).toHaveLength(1);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.transaction).not.toHaveBeenCalled();
      expect(f.inserts).toEqual([]);
    });
  }

  it("returns the normal owner-only 404 for another owner's task and a missing task", async () => {
    const f = fixture("completed", true, otherOwner);
    for (const taskId of [id, missingId]) {
      const response = await f.request(`/api/agent-config-sync/tasks/${taskId}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "REQUEST_NOT_FOUND" });
    }
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("keeps config false and source/mutation routes unavailable while native creation stays ordinary", async () => {
    const f = fixture("queued");
    expect(await (await f.request("/api/agent-config-sync/config")).json()).toMatchObject({ msg: { enabled: false, maxAgents: 50 } });
    for (const [path, init] of [
      ["/api/agent-config-sync/users?q=Alice", {}],
      [`/api/agent-config-sync/users/${otherOwner}/agents`, {}],
      ["/api/agent-config-sync/previews", jsonRequest("POST", request)],
      [`/api/agent-config-sync/tasks/${id}/apply`, jsonRequest("POST", { idempotencyKey: "apply" })],
    ] as const) {
      const response = await f.request(path, init);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "EVAL_SP_UNAVAILABLE" });
    }
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.queries).toEqual([]);
    expect(f.transaction).not.toHaveBeenCalled();
    const created = await f.request("/api/agent-configs", jsonRequest("POST", {
      name: "Native", slug: "native", setting: { mcpServers: [] }, purpose: "execution",
    }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ msg: { id: agentId, name: "Native" } });
    expect(f.fetch.mock.calls.map(([input, init]) => {
      // The HTTP client owns the Request body; inspecting a consumed request must not re-wrap it.
      const req = input instanceof Request ? input : new Request(input, init);
      return [req.method, new URL(req.url).pathname];
    })).toEqual([["GET", "/api/mcp-servers"], ["GET", "/api/mcp-servers"], ["POST", "/api/user-agent-configs"]]);
    expect(f.inserts).toEqual([agentConfigPurposes]);
    expect(f.transaction).not.toHaveBeenCalled();
  });
});
