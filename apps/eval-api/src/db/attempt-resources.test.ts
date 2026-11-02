import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { AgentResourceSnapshotDownload, AgentResourceSnapshotPage } from "@eval-platform/eval-contracts";
import { compactNativeTrajectoryRecord } from "@eval-platform/eval-metrics";
import { nativeFixture } from "../sp/native-test-fixture.js";
import { createPostgresResourceSnapshotReader, updateWithResources } from "./attempt-resources.js";
import { READ_SNAPSHOT } from "./client.js";
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

function caseDb(results: Array<Record<string, unknown>[]>) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (statement: SQL) => {
    statements.push(new PgDialect().sqlToQuery(statement));
    return { rows: results.shift() ?? [] };
  });
  const transaction = vi.fn(async (read: (transaction: { execute: typeof execute }) => Promise<unknown>,
    _options: unknown) => read({ execute }));
  return { db: { transaction } as unknown as EvalDb, statements, transaction };
}

describe("bounded read-only case usage projection", () => {
  const selection = { projectId: "project-1", samplingId: "sampling-1", role: "execution" as const,
    section: "models" as const, attemptId: "attempt-1", page: 2, pageSize: 5 };
  const attempt = { attemptId: "attempt-1", resourcesStatus: "collected", usageCoverage: "partial",
    billingCoverage: "partial", finalized: "false" };

  it("selects one current owned Attempt and only five scalar model/billing rows under a consistent snapshot", async () => {
    const { db, statements, transaction } = caseDb([
      [{ total: 9 }], [attempt], [{ total: 17 }], [{ index: 6, eventId: "usage-6", inputTokens: "7",
        status: "settled", settlementMatches: 1, debitedUnits: "2" }],
    ]);
    const result = await createPostgresResourceSnapshotReader(db, "owner-1").readCaseUsage(selection);
    expect(result).toMatchObject({ total: 17, attempt, rows: [{ index: 6, eventId: "usage-6" }] });
    expect(transaction.mock.calls[0]?.[1]).toEqual(READ_SNAPSHOT);
    expect(statements).toHaveLength(4);
    expect(statements[0]?.sql).toMatch(/JOIN eval_projects AS p.*p.deleted_at IS NULL/su);
    expect(statements[1]?.sql).toMatch(/a.value->>.* = .*LIMIT 2/su);
    expect(statements[2]?.sql).toContain("json_array_length(r.snapshot->'usageEvents')");
    const page = statements[3]!;
    expect(page.sql).toMatch(/WITH body AS MATERIALIZED.*page AS MATERIALIZED/su);
    expect(page.sql).toContain("json_array_elements(body.snapshot->'usageEvents')");
    expect(page.sql).toContain("json_array_elements(body.snapshot->'billingSettlements')");
    expect(page.sql).toContain("duplicate.value->>'eventId'");
    expect(page.sql).toContain("b.value->>'accountId'");
    expect(page.sql).not.toMatch(/SELECT \*|metric_snapshot|nativeRecords|toolArguments/su);
    expect(page.params).toEqual(expect.arrayContaining([5, "owner-1", "attempt-1", "inputTokens", "debitedUnits"]));
    expect(page.params).not.toContain("private raw snapshot");
  });

  it("lists Attempt metadata only and requires current membership in the selected original Run", async () => {
    const { db, statements } = caseDb([[{ total: 13 }], [attempt, { ...attempt, attemptId: "attempt-2" }]]);
    const result = await createPostgresResourceSnapshotReader(db, "owner-1").readCaseUsage({
      ...selection, section: "attempts", attemptId: undefined, page: 1, pageSize: 2, runId: "run-1",
    });
    expect(result.total).toBe(13);
    expect(result.rows).toHaveLength(2);
    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toMatch(/eval_run_samplings.*r.operation IN \('execution', 'pipeline'\)/su);
    expect(statements[1]?.sql).toMatch(/OFFSET .* LIMIT /su);
    expect(statements[1]?.sql).not.toMatch(/eval_attempt_resources|metric_snapshot|jsonb_array_elements\([^)]*nativeRecords|toolArguments/su);
  });

  it("scopes an Evaluator to its parent Sampling and exact Evaluation member, including Action missing-ID rows", async () => {
    const { db, statements } = caseDb([[{ total: 2 }], [attempt], [{ total: 2 }],
      [{ index: 3, executionId: null, chargedCredits: "3", executionMatches: 0 }]]);
    const result = await createPostgresResourceSnapshotReader(db, "owner-1").readCaseUsage({
      projectId: "project-1", samplingId: "sampling-1", role: "evaluation", evaluationId: "evaluation-1",
      runId: "run-1", section: "actions", attemptId: "attempt-1", page: 2, pageSize: 1,
    });
    expect(result.rows).toEqual([{ index: 3, executionId: null, chargedCredits: "3", executionMatches: 0 }]);
    expect(statements[0]?.sql).toMatch(/JOIN eval_evaluations AS e.*e.evaluation_id = .*eval_run_evaluations.*m.evaluation_id = e.evaluation_id/su);
    expect(statements[2]?.sql).toContain("b.value->>'source' =");
    expect(statements[2]?.params).toContain("action");
    expect(statements[3]?.sql).toMatch(/executionMatches.*FROM page CROSS JOIN body/su);
    expect(statements[3]?.sql).toMatch(/WHERE .*ORDER BY b.ordinal OFFSET .* LIMIT /su);
    expect(statements[3]?.sql).not.toContain("b.ordinal >");
    expect(statements[3]?.sql).toMatch(/json_array_elements\(CASE WHEN json_typeof\(body.snapshot->'nativeRecords'\)/su);
    expect(statements[3]?.sql).not.toMatch(/SELECT \*|toolArguments|metric_snapshot/su);
  });

  it("joins Action charges only to unique scoped v2 SAFE Tool Results/Calls in SQL", async () => {
    const { db, statements, transaction } = caseDb([[{ total: 1 }], [attempt], [{ total: 1 }], [{
      index: 1, executionId: "execution-1", executionMatches: 1, linkMatches: 1,
      toolCallMatches: 1, namedToolCallMatches: 1, resultCallMatches: 1,
      legacyCompact: false, toolName: "api.search", actionId: "action.exa.search",
    }]]);
    await createPostgresResourceSnapshotReader(db, "owner-1").readCaseUsage({
      ...selection, section: "actions", page: 1, pageSize: 1,
    });
    expect(transaction.mock.calls[0]?.[1]).toEqual(READ_SNAPSHOT);
    const page = statements[3]!;
    expect(page.sql).toMatch(/json_array_elements\(CASE WHEN json_typeof\(body.snapshot->'nativeRecords'\)/su);
    expect(page.sql).toMatch(/metricProjection.*chargeLinkVersion/su);
    expect(page.sql).toContain("f.fact->>'executionId'");
    expect(page.sql).toContain('AS "billingSource"');
    expect(page.sql).toMatch(/f\.value->>'kind' IN \('pi\.tool-result', 'pi\.toolResult'\)/u);
    expect(page.sql).not.toContain("r.message->>'toolCallId'");
    expect(page.sql).toMatch(/AS "actionId".*AS "actionIdPresent".*AS "linkMatches".*AS "toolCallMatches"/su);
    expect(page.sql).not.toMatch(/projectedCapabilityIds|capability_id|inventory/su);
    expect(page.sql).toMatch(/scope.*chatId.*resource.*sessionId/su);
    expect(page.sql).toMatch(/call\.agent_id = result\.agent_id AND call\.submission_id = result\.submission_id\s+AND call\.tool_call_key = result\.tool_call_key/su);
    expect(page.sql).toMatch(/duplicate\.agent_id = result\.agent_id AND duplicate\.submission_id = result\.submission_id\s+AND duplicate\.tool_call_key = result\.tool_call_key/su);
    expect(page.sql).not.toMatch(/SELECT \*|metric_snapshot|toolArguments|accountId.*AS "accountId"/su);
    expect(page.params).toContain("owner-1");
    expect(page.params).toContain(1);
  });

  it("pages only the selected Action or Super Link source and projects Action IDs from ledger facts, never SAFE details", async () => {
    for (const section of ["actions", "tools"] as const) {
      const { db, statements } = caseDb([[{ total: 1 }], [attempt], [{ total: 1 }], [{
        index: 2, billingSource: section === "actions" ? "action" : "tool",
        actionId: section === "actions" ? "action.exa.search" : null, chargedCredits: "7",
      }]]);
      const result = await createPostgresResourceSnapshotReader(db, "owner-1").readCaseUsage({
        ...selection, section, page: 1,
      });
      expect(result.total).toBe(1);
      expect(statements[2]?.params).toContain(section === "actions" ? "action" : "tool");
      expect(statements[3]?.params).toContain(section === "actions" ? "action" : "tool");
      const page = statements[3]!.sql;
      if (section === "actions") expect(page).toContain("page.fact->>'actionId'");
      else {
        expect(page).not.toContain("actionId");
        expect(page).not.toContain("nativeRecords");
      }
      expect(page).toContain("private|prompt");
      expect(page).not.toMatch(/f\.fact->>'capabilityId'|AS "capabilityId"|projectedCapabilityIds/u);
      expect(page).toContain("duplicate.value->>'source'");
    }
  });

  it("keeps Action/Tool receipts out of paired model settlements even when their execution ID is missing", async () => {
    const { db, statements } = caseDb([[{ total: 1 }], [attempt], [{ total: 1 }], [{
      index: 1, eventId: "usage-1", settlementMatches: 1, debitedUnits: "3",
    }]]);
    await createPostgresResourceSnapshotReader(db, "owner-1").readCaseUsage({
      ...selection, page: 1,
    });
    const page = statements[3]!.sql;
    expect(page).toContain("b.value->>'source'");
    expect(page).toContain("b.value->>'eventId' = page.fact->>'eventId'");
    expect(page).toMatch(/AND \(b\.value->>'source' IS NULL OR b\.value->>'source' = 'model'\)\s+AND b\.value->>'executionId' IS NULL/u);
  });

  it("matches only v2 derived keys without a raw or v1 Tool ID fallback", async () => {
    const { db, statements } = caseDb([[{ total: 1 }], [attempt], [{ total: 1 }], [{
      index: 1, executionId: "execution-1", executionMatches: 1, linkMatches: 1,
      toolCallMatches: 1, namedToolCallMatches: 1, resultCallMatches: 1,
    }]]);
    await createPostgresResourceSnapshotReader(db, "owner-1").readCaseUsage({
      ...selection, section: "actions", page: 1, pageSize: 1,
    });
    const query = statements[3]!.sql;
    expect(query).toContain("chargeLinkVersion");
    expect(query).toContain("f.fact->>'toolCallKey'");
    expect(query).not.toContain("raw AS MATERIALIZED");
    expect(query).not.toContain("f.fact->>'toolCallId'");
    expect(query).not.toContain("r.message->>'toolCallId'");
    expect(statements[3]!.params).toContain("^tck2_[0-9a-f]{64}$");
    expect(statements[3]!.params).toContain(69);
    expect(statements[3]!.params).toContain("2");
    expect(query).not.toContain("link_mode");
    expect(query).toMatch(/call\.agent_id = result\.agent_id AND call\.submission_id = result\.submission_id/u);
    expect(query).toMatch(/call\.tool_name = result\.tool_name/u);
  });

  it("never asks PostgreSQL for a snapshot when the selected Attempt's resources were not collected", async () => {
    const { db, statements } = caseDb([[{ total: 1 }], [{ ...attempt, resourcesStatus: "pending" }]]);
    const result = await createPostgresResourceSnapshotReader(db, "owner-1").readCaseUsage(selection);
    expect(result).toEqual({ total: null, rows: [], attempt: { ...attempt, resourcesStatus: "pending" } });
    expect(statements).toHaveLength(2);
  });

  it("denies a missing/deleted/foreign current case before even selecting an Attempt or its snapshot", async () => {
    const { db, statements } = caseDb([[]]);
    await expect(createPostgresResourceSnapshotReader(db, "owner-1").readCaseUsage(selection))
      .rejects.toMatchObject({ code: "SAMPLING_NOT_FOUND" });
    expect(statements).toHaveLength(1);
  });
});
