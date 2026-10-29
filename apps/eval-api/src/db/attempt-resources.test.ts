import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { AgentResourceSnapshotDownload, AgentResourceSnapshotPage } from "@eval-platform/eval-contracts";
import { compactNativeTrajectoryRecord } from "@eval-platform/eval-metrics";
import { nativeFixture } from "../sp/native-test-fixture.js";
import { updateWithResources } from "./attempt-resources.js";
import type { EvalDb } from "./client.js";

const chatId = "33333333-3333-4333-8333-333333333333";
const submissionId = "77777777-7777-4777-8777-777777777777";
const scope = { chatId, idempotencyKey: "execution:sampling-1", submissionId };
const readiness = {
  receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: 0, pendingRuntimeEvents: 0,
  actionCharges: { complete: true, unsettledExecutions: 0, missingExecutionIds: 0 },
};
const action = { source: "tool", executionId: "88888888-8888-4888-8888-888888888888",
  status: "failed", chargedCredits: 0 };

/** Check the real writer's SQL and bounded inputs without creating, connecting to,
 * truncating or deleting any database; isolated PostgreSQL tests need a safe local DB. */
function fakeDb() {
  const statements: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (statement: SQL) => {
    const query = new PgDialect().sqlToQuery(statement);
    statements.push({ sql: query.sql, params: query.params });
    return { rows: [] };
  });
  const db = { transaction: async (read: (transaction: { execute: typeof execute }) => Promise<void>) =>
    read({ execute }) } as unknown as EvalDb;
  return { db, statements };
}

async function pageDownload(patch: Partial<AgentResourceSnapshotDownload["summary"]["counts"]> = {},
  omitLast = false): Promise<AgentResourceSnapshotDownload> {
  const root = nativeFixture(3, chatId, submissionId);
  const child = nativeFixture(8, chatId, "child-submission");
  const withParent = { ...child, record: { ...child.record, parent: {
    resource: { agentId: "agent-1", sessionId: chatId }, submissionId,
  } } };
  const native = [await compactNativeTrajectoryRecord(root, scope),
    await compactNativeTrajectoryRecord(withParent, scope)];
  const usage = Array.from({ length: 300 }, (_, index) => ({
    eventId: `event-${index}`, kind: "assistant_model", metrics: { totalTokens: index + 1 },
  }));
  const bills = usage.map((event) => ({ eventId: event.eventId,
    accountId: "11111111-1111-4111-8111-111111111111", status: "settled", debitedUnits: 2 }));
  return {
    kind: "pages",
    summary: {
      scope, observedAt: "2026-10-28T00:00:00.000Z", finalized: true, readiness,
      coverage: { usageEvents: "complete", nativeRecords: "complete", billingSettlements: "partial" },
      counts: { usageEvents: 300, nativeRecords: 2, billingSettlements: 301, ...patch },
    },
    creditsTotal: 600,
    async *readPages(): AsyncIterable<AgentResourceSnapshotPage> {
      for (const row of native) yield { stream: "nativeRecords", records: [row] };
      for (const start of [0, 200]) {
        yield { stream: "usageEvents", records: usage.slice(start, start + 200) };
        if (!omitLast || start === 0) yield { stream: "billingSettlements", records: bills.slice(start, start + 200) };
      }
      if (!omitLast) yield { stream: "billingSettlements", records: [action] };
    },
    dispose: async () => undefined,
  };
}

describe("paged Attempt resource Store write", () => {
  it("uses bounded page inputs and one atomic SQL projection of both existing JSON columns, preserving Action and API facts", async () => {
    const { db, statements } = fakeDb();
    const snapshot = await pageDownload();
    await updateWithResources(db, { attemptId: "attempt-1", snapshot }, async () => ({
      ownerUserId: "11111111-1111-4111-8111-111111111111", samplingId: "sampling-1",
    }));
    expect(statements[0]?.sql).toContain("CREATE TEMP TABLE eval_resource_fragments");
    expect(statements.filter(({ sql }) => sql.includes("INSERT INTO pg_temp.eval_resource_fragments"))).toHaveLength(7);
    expect(statements.at(-1)?.sql).toContain("INSERT INTO eval_attempt_resources");
    expect(statements.at(-1)?.sql).toContain("json_agg(item.value ORDER BY chunk.position, item.ordinal)");
    expect(statements.at(-1)?.sql).toContain("body.snapshot, body.snapshot");
    expect(statements.at(-1)?.sql).toMatch(/'observedAt', \$\d+::text/);
    expect(statements.at(-1)?.sql).toMatch(/'finalized', \$\d+::boolean/);
    expect(statements.slice(1, -1).every(({ params }) =>
      params.every((param) => typeof param !== "string" || Buffer.byteLength(param) <= 4_000_000))).toBe(true);
    expect(statements.at(-1)?.params).toEqual(expect.arrayContaining([
      JSON.stringify(snapshot.summary.coverage), JSON.stringify(snapshot.summary.readiness),
    ]));
  });

  it("assembles only nine verified compact rows and paired bills into the same Attempt write, keeping coverage partial", async () => {
    const usage = Array.from({ length: 9 }, (_, index) => ({
      eventId: `known-${index}`, metrics: { totalTokens: index + 1 },
    }));
    const bills = usage.map(({ eventId }) => ({ eventId, status: "settled", debitedUnits: 2 }));
    const native = await Promise.all(Array.from({ length: 9 }, (_, index) =>
      compactNativeTrajectoryRecord(nativeFixture(index + 1, chatId, submissionId), scope)));
    const coverage = { usageEvents: "partial", nativeRecords: "partial", billingSettlements: "partial" } as const;
    const partial: AgentResourceSnapshotDownload = {
      kind: "pages", summary: {
        scope, observedAt: "2026-10-28T00:10:01.000Z", finalized: false, coverage,
        readiness: { ...readiness, pendingTelemetryEvents: 1 },
        counts: { usageEvents: 9, nativeRecords: 9, billingSettlements: 9 },
      },
      creditsTotal: null,
      async *readPages(): AsyncIterable<AgentResourceSnapshotPage> {
        for (const row of native) yield { stream: "nativeRecords", records: [row] };
        yield { stream: "usageEvents", records: usage };
        yield { stream: "billingSettlements", records: bills };
        yield { stream: "billingSettlements", records: [] }; // No settled Action facts; not a zero-fee claim.
      },
      dispose: async () => undefined,
    };
    const { db, statements } = fakeDb();
    let updated = false;
    await updateWithResources(db, { attemptId: "attempt-1", snapshot: partial }, async () => {
      updated = true;
      return { ownerUserId: "11111111-1111-4111-8111-111111111111", samplingId: "sampling-1" };
    });
    expect(updated).toBe(true);
    expect(statements.filter(({ sql }) => sql.includes("INSERT INTO pg_temp.eval_resource_fragments"))).toHaveLength(12);
    expect(statements.at(-1)?.sql).toContain("INSERT INTO eval_attempt_resources");
    expect(statements.at(-1)?.params).toEqual(expect.arrayContaining([
      false, JSON.stringify(coverage), JSON.stringify(partial.summary.readiness),
    ]));
    const fragments = statements.filter(({ sql }) => sql.includes("INSERT INTO pg_temp.eval_resource_fragments"));
    expect(fragments.filter(({ params }) => params.includes("nativeRecords"))).toHaveLength(9);
    expect(fragments.filter(({ params }) => params.includes("usageEvents"))).toHaveLength(1);
    expect(fragments.filter(({ params }) => params.includes("billingSettlements"))).toHaveLength(2);
    expect(JSON.stringify(statements)).not.toContain("known-9"); // The unsettled tenth is not invented or billed.
  });

  it("never inserts a truncated collection if a billed page, action inventory or declared count is missing", async () => {
    for (const download of [await pageDownload({}, true), await pageDownload({ nativeRecords: 3 })]) {
      const { db, statements } = fakeDb();
      await expect(updateWithResources(db, { attemptId: "attempt-1", snapshot: download },
        async () => ({ ownerUserId: "owner-1", samplingId: "sampling-1" })))
        .rejects.toThrow(/incomplete|usage is not followed/u);
      expect(statements.some(({ sql }) => sql.includes("INSERT INTO eval_attempt_resources"))).toBe(false);
    }
  });
});
