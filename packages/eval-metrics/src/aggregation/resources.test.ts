import { describe, expect, it } from "vitest";
import type { AgentResourceFact, AgentResourceScope, NativeTrajectoryEntry } from "@eval-platform/eval-contracts";
import { nativeFixture, nativeResourceInput, resourceInput, settlement, usage } from "../test-support.js";
import { aggregateResources } from "./resources.js";

const SCOPE = { chatId: "subject-chat", submissionId: "subject-submission", idempotencyKey: "execution:sampling-1" } satisfies AgentResourceScope;

/** Only negative/contradictory cases edit an actual publicly projected UA fact. */
function variant(seq: number, ingestSeq: number, edit: (event: Record<string, unknown>) => void): NativeTrajectoryEntry {
  const item = nativeFixture(seq)[0]!;
  const write = item.record.record;
  if (write.type !== "entry" || write.value.kind !== "springbrand.trajectory") throw new Error("Expected native event fact");
  const value = write.value as Record<string, unknown>;
  value.id = ingestSeq;
  const data = value.data as { event: Record<string, unknown> };
  data.event.eventId = `fact-${ingestSeq}`;
  edit(data.event);
  return { ...item, ingestSeq };
}

describe("resource statistics", () => {
  it("proves zero only from complete finalized empty sources", () => {
    const complete = aggregateResources([resourceInput()]);
    expect(complete.tokens.total).toEqual({ value: 0, coverage: "complete" });
    expect(complete.cacheHitRate).toEqual({ value: null, coverage: "complete" });
    expect(complete.costs.chargedUnits).toEqual({ value: 0, coverage: "complete" });
    expect(complete.trajectory.tools.count).toEqual({ value: 0, coverage: "complete" });
    expect(complete.collections).toEqual({ collected: 1, pending: 0, failed: 0, uncollected: 0, unsubmitted: 0, finalized: 1 });
    expect(aggregateResources([]).tokens.total).toEqual({ value: null, coverage: "unavailable" });
  });

  it("retains pending, failed and unsubmitted collection states without fabricating zero", () => {
    const result = aggregateResources([
      { ownerUserId: "owner-1", collection: undefined },
      { ownerUserId: "owner-1", collection: { status: "pending", scope: SCOPE } },
      { ownerUserId: "owner-1", collection: { status: "failed", scope: SCOPE, collectedAt: "2026-10-08", error: "Network" } },
    ]);
    expect(result.collections).toMatchObject({ collected: 0, pending: 1, failed: 1, unsubmitted: 1 });
    expect(result.tokens.input).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.turns.count).toEqual({ value: null, coverage: "unavailable" });
  });

  it("classifies an unclosed operation from a terminal Attempt as unknown", () => {
    const result = aggregateResources([{
      ...nativeResourceInput([3, 5, 16]),
      canEmitNativeRecords: false,
    }]);
    expect(result.modelRequests).toMatchObject({ count: { value: 1 }, inProgress: 0, unknown: 1 });
    expect(result.trajectory.turns).toMatchObject({ count: { value: 1 }, completed: 1, inProgress: 0, unknown: 0 });
  });

  it("marks observed values partial when another attempt's resources are missing", () => {
    const result = aggregateResources([
      resourceInput({ usageEvents: [usage("usage-1")] }),
      { ownerUserId: "owner-1", collection: { status: "pending", scope: SCOPE } },
    ]);
    expect(result.tokens.total).toEqual({ value: 35, coverage: "partial" });
    expect(result.cacheHitRate).toEqual({ value: 3 / 13, coverage: "partial" });
    expect(result.costs.providerUsd).toEqual({ value: 0.5, coverage: "partial" });
    expect(result.trajectory.tools.count).toEqual({ value: null, coverage: "unavailable" });
  });

  it.each(["partial", "unavailable"] as const)("does not treat declared %s sources as complete", (coverage) => {
    const result = aggregateResources([resourceInput({
      usageEvents: [usage("usage-1")], coverage: { usageEvents: coverage, nativeRecords: coverage, billingSettlements: coverage },
    })]);
    expect(result.tokens.total).toEqual({ value: 35, coverage: "partial" });
    expect(result.costs.chargedUnits.value).toBeNull();
  });

  it("does not treat an unfinalized snapshot as a complete total", () => {
    const result = aggregateResources([resourceInput({ finalized: false, usageEvents: [usage("usage-1")] })]);
    expect(result.collections.finalized).toBe(0);
    expect(result.tokens.input).toEqual({ value: 10, coverage: "partial" });
    expect(result.trajectory.tools.count).toEqual({ value: null, coverage: "unavailable" });
  });

  it("keeps missing token fields unknown and reasoning separate from total tokens", () => {
    const result = aggregateResources([resourceInput({ usageEvents: [
      usage("full"), usage("incomplete", { metrics: { inputTokens: 5, outputTokens: 0, reasoningTokens: 0 } }),
    ] })]);
    expect(result.tokens.input).toEqual({ value: 15, coverage: "complete" });
    expect(result.tokens.output).toEqual({ value: 20, coverage: "complete" });
    expect(result.tokens.reasoning).toEqual({ value: 4, coverage: "complete" });
    expect(result.tokens.cacheRead).toEqual({ value: 3, coverage: "partial" });
    expect(result.tokens.total).toEqual({ value: 35, coverage: "partial" });
    expect(result.cacheHitRate).toEqual({ value: 3 / 18, coverage: "partial" });
  });

  it("uses an explicit trusted total without deriving missing buckets", () => {
    const result = aggregateResources([resourceInput({ usageEvents: [usage("usage-1", { metrics: { totalTokens: 42, reasoningTokens: 7 } })] })]);
    expect(result.tokens.total).toEqual({ value: 42, coverage: "complete" });
    expect(result.tokens.input).toEqual({ value: null, coverage: "unavailable" });
    expect(result.tokens.reasoning.value).toBe(7);
  });

  it("deduplicates source identities across snapshots and ignores object key order", () => {
    const event = usage("usage-1");
    const reordered = Object.fromEntries(Object.entries(event).reverse());
    const started = nativeFixture(8)[0]!;
    const result = aggregateResources([
      nativeResourceInput([], { usageEvents: [event, reordered], nativeRecords: [started], billingSettlements: [settlement("usage-1")] }),
      nativeResourceInput([], { usageEvents: [event], nativeRecords: [started], billingSettlements: [settlement("usage-1")] }),
    ]);
    expect(result.tokens.total.value).toBe(35);
    expect(result.trajectory.tools.count.value).toBe(1);
    expect(result.costs.modelDebitedUnits.value).toBe(8);
    expect(result.duplicateRecords).toEqual({ usageEvents: 2, nativeRecords: 1, billingSettlements: 1 });
  });

  it("keeps different users, accounts and sessions with the same local ID separate", () => {
    const result = aggregateResources([
      nativeResourceInput([5], { usageEvents: [usage("shared")], billingSettlements: [settlement("shared")] }),
      nativeResourceInput([5], { usageEvents: [usage("shared")], billingSettlements: [settlement("shared", { accountId: "account-2" })] }, "owner-2"),
    ]);
    expect(result.tokens.total.value).toBe(70);
    expect(result.modelRequests.count.value).toBe(2);
    expect(result.costs.modelDebitedUnits.value).toBe(16);
    expect(result.duplicateRecords).toEqual({ usageEvents: 0, nativeRecords: 0, billingSettlements: 0 });
  });

  it("isolates contradictory facts instead of picking whichever came last", () => {
    const result = aggregateResources([resourceInput({ usageEvents: [
      usage("conflict"), usage("conflict", { metrics: { inputTokens: 100 } }), usage("known"),
    ], billingSettlements: [settlement("conflict"), settlement("conflict", { debitedUnits: 999 })] })]);
    expect(result.tokens.total).toEqual({ value: 35, coverage: "partial" });
    expect(result.costs.chargedUnits).toEqual({ value: null, coverage: "unavailable" });
    expect(result.diagnostics.filter((item) => item.kind === "conflicting-identity")).toHaveLength(2);
  });

  it("diagnoses missing identities and unsupported facts without claiming complete zero", () => {
    const missingToolId = variant(8, 8, (event) => { delete event.toolCallId; });
    const result = aggregateResources([nativeResourceInput([], {
      usageEvents: [{ kind: "assistant_model", metrics: { inputTokens: 1 } }, usage("unsupported", { kind: "new-kind" })],
      nativeRecords: [missingToolId],
      billingSettlements: [{ eventId: "missing-account", debitedUnits: 5 }],
    })]);
    expect(result.tokens.input).toEqual({ value: null, coverage: "unavailable" });
    expect(result.trajectory.tools.count).toEqual({ value: null, coverage: "unavailable" });
    expect(result.costs.modelDebitedUnits).toEqual({ value: null, coverage: "unavailable" });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "billingSettlements", kind: "missing-identity" }),
      expect.objectContaining({ stream: "usageEvents", kind: "unsupported-record" }),
    ]));
  });

  it("requires usage run identity and complete subagent identity for overlap decisions", () => {
    const result = aggregateResources([resourceInput({ usageEvents: [
      usage("missing-run", { runId: null }), usage("missing-parent", { kind: "subagent", subagentRunId: "child" }),
    ] })]);
    expect(result.tokens.total.value).toBeNull();
    expect(result.diagnostics.map((item) => item.kind)).toEqual(["missing-identity", "missing-identity"]);
  });

  it("counts outer subagent summaries once but retains all distinct real settlements", () => {
    const result = aggregateResources([resourceInput({ usageEvents: [
      usage("root", { runId: "root-run", metrics: { totalTokens: 5 } }),
      usage("child-summary", { kind: "subagent", runId: "root-run", subagentRunId: "child-run", parentRunId: "root-run", metrics: { totalTokens: 100 } }),
      usage("child-detail", { runId: "child-run", metrics: { totalTokens: 60 } }),
      usage("nested-summary", { kind: "subagent", runId: "child-run", subagentRunId: "nested-run", parentRunId: "child-run", metrics: { totalTokens: 40 } }),
      usage("nested-detail", { runId: "nested-run", metrics: { totalTokens: 40 } }),
    ], billingSettlements: [settlement("child-detail"), settlement("nested-detail")] })]);
    expect(result.tokens.total).toEqual({ value: 105, coverage: "complete" });
    expect(result.costs.providerUsd.value).toBe(1);
    expect(result.overlappingUsageRecords).toBe(3);
    expect(result.byModel[0]!.usageRecords).toBe(2);
    expect(result.costs.modelDebitedUnits.value).toBe(16);
  });

  it("uses valid child detail when a subagent summary has no trusted metrics or provider cost", () => {
    const child = usage("child-detail", {
      runId: "child-run",
      metrics: { inputTokens: 70, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0 },
      providerCostUsd: { total: 3 },
    });
    const summary: AgentResourceFact = {
      eventId: "child-summary", runId: "root-run", subagentRunId: "child-run", parentRunId: "root-run",
      kind: "subagent", outcome: "missing_trusted_usage",
    };
    const result = aggregateResources([resourceInput({ usageEvents: [child, summary] })]);
    expect(result.tokens.total).toEqual({ value: 100, coverage: "partial" });
    expect(result.tokens.input).toEqual({ value: 70, coverage: "partial" });
    expect(result.costs.providerUsd).toEqual({ value: 3, coverage: "partial" });
    expect(result.overlappingUsageRecords).toBe(0);
  });

  it("chooses summary values per metric and keeps child provider cost when only tokens are summarized", () => {
    const child = usage("child-detail", {
      runId: "child-run",
      metrics: { inputTokens: 70, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0 },
      providerCostUsd: { total: 3 },
    });
    const summary: AgentResourceFact = {
      eventId: "child-summary", runId: "root-run", subagentRunId: "child-run", parentRunId: "root-run",
      kind: "subagent", outcome: "billable",
      metrics: { inputTokens: 70, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0 },
    };
    const result = aggregateResources([resourceInput({ usageEvents: [child, summary] })]);
    expect(result.tokens.total).toEqual({ value: 100, coverage: "complete" });
    expect(result.tokens.input).toEqual({ value: 70, coverage: "complete" });
    expect(result.costs.providerUsd).toEqual({ value: 3, coverage: "partial" });
    expect(result.overlappingUsageRecords).toBe(1);
  });

  it("does not let ambiguous summaries hide child detail", () => {
    const result = aggregateResources([resourceInput({ usageEvents: [
      usage("summary-1", { kind: "subagent", subagentRunId: "child-run", parentRunId: "run-1" }),
      usage("summary-2", { kind: "subagent", subagentRunId: "child-run", parentRunId: "run-1", metrics: { totalTokens: 999 } }),
      usage("child-detail", { runId: "child-run", metrics: { totalTokens: 10 } }),
    ] })]);
    expect(result.tokens.total).toEqual({ value: 10, coverage: "partial" });
    expect(result.overlappingUsageRecords).toBe(0);
    expect(result.diagnostics.filter((item) => item.kind === "conflicting-identity")).toHaveLength(2);
  });

  it("detects cyclic subagent relationships rather than dropping every record", () => {
    const result = aggregateResources([resourceInput({ usageEvents: [
      usage("summary-1", { kind: "subagent", subagentRunId: "child-1", parentRunId: "child-2" }),
      usage("summary-2", { kind: "subagent", subagentRunId: "child-2", parentRunId: "child-1" }),
      usage("detail", { runId: "child-1", metrics: { totalTokens: 10 } }),
    ] })]);
    expect(result.tokens.total).toEqual({ value: 10, coverage: "partial" });
    expect(result.diagnostics.some((item) => item.message.includes("cycle"))).toBe(true);
  });

  it("separates provider USD, model settlement and actual action charges", () => {
    const result = aggregateResources([nativeResourceInput([10], {
      usageEvents: [usage("usage-1")],
      billingSettlements: [
        settlement("usage-1"), { executionId: "action-1", status: "succeeded", chargedCredits: 5 },
        { executionId: "action-2", status: "failed", chargedCredits: 0 },
      ],
    })]);
    expect(result.costs).toEqual({
      providerUsd: { value: 0.5, coverage: "complete" }, modelDebitedUnits: { value: 8, coverage: "complete" },
      actionChargedUnits: { value: 5, coverage: "complete" }, chargedUnits: { value: 13, coverage: "complete" },
      ratedUnits: { value: 10, coverage: "complete" }, shortfallUnits: { value: 2, coverage: "complete" },
      platformOwnedUnits: { value: 2, coverage: "complete" },
    });
  });

  it("preserves null settlement fields and does not infer actual charges from rated units", () => {
    const result = aggregateResources([resourceInput({ billingSettlements: [settlement("usage-1", {
      ratedUnits: null, debitedUnits: null, platformOwned: { units: null },
    })] })]);
    expect(result.costs.ratedUnits.value).toBeNull();
    expect(result.costs.modelDebitedUnits.value).toBeNull();
    expect(result.costs.chargedUnits.value).toBeNull();
    expect(result.costs.platformOwnedUnits.value).toBeNull();
    expect(result.costs.shortfallUnits.value).toBe(2);
  });

  it("does not claim final charges when an action is still running", () => {
    const result = aggregateResources([resourceInput({ billingSettlements: [
      settlement("usage-1"), { executionId: "action-1", status: "running", chargedCredits: 0 },
    ] })]);
    expect(result.costs.chargedUnits).toEqual({ value: 8, coverage: "partial" });
    expect(result.costs.actionChargedUnits).toEqual({ value: null, coverage: "unavailable" });
    const pending = aggregateResources([resourceInput({ billingSettlements: [{ executionId: "action-1", status: "running", chargedCredits: 0 }] })]);
    expect(pending.costs.chargedUnits).toEqual({ value: null, coverage: "unavailable" });
  });

  it("does not turn unsupported settlement shapes or statuses into complete charges", () => {
    const result = aggregateResources([resourceInput({ billingSettlements: [
      settlement("unsupported", { status: "provisional" }),
      { executionId: "action-1", status: "queued", chargedCredits: 0 },
      { id: "private-row", charged_credits: 10, account_id: "account-1" },
    ] })]);
    expect(result.costs.chargedUnits).toEqual({ value: null, coverage: "unavailable" });
    expect(result.diagnostics.filter((item) => item.kind === "unsupported-record")).toHaveLength(2);
    expect(result.diagnostics.filter((item) => item.kind === "missing-identity")).toHaveLength(1);
  });

  it("groups usage by provider/model without treating usage rows as model requests", () => {
    const result = aggregateResources([resourceInput({ usageEvents: [
      usage("compaction", { kind: "compaction" }), usage("title", { kind: "chat_title" }),
      usage("other", { providerMetadata: { provider: "provider-2", model: "model-2" } }),
    ] })]);
    expect(result.byModel).toHaveLength(2);
    expect(result.byModel[0]).toMatchObject({ provider: "provider-1", model: "model-1", usageRecords: 2 });
    expect(result.byModel[0]!.tokens.total.value).toBe(70);
    expect(result.modelRequests.count.value).toBe(0);
  });

  it("pairs actual Turn/generation/Tool IDs regardless of source observation order", () => {
    const reversed = nativeFixture(...Array.from({ length: 16 }, (_, index) => index + 1)).toReversed();
    const result = aggregateResources([nativeResourceInput([], { nativeRecords: reversed })]);
    expect(result.trajectory.turns).toMatchObject({ count: { value: 1, coverage: "complete" }, completed: 1, durationMs: { mean: 400 } });
    expect(result.modelRequests).toMatchObject({ count: { value: 2, coverage: "complete" }, completed: 2, durationMs: { mean: 110 } });
    expect(result.trajectory.tools).toMatchObject({ count: { value: 1, coverage: "complete" }, failed: 1, durationMs: { mean: 40 } });
    expect(result.trajectory.byTool[0]).toMatchObject({ toolName: "search", count: { value: 1 }, durationMs: { total: 40 } });
  });

  it("keeps cancelled, unknown and in-progress native operations distinct", () => {
    const cancelled = variant(16, 16, (event) => { (event.payload as Record<string, unknown>).outcome = "cancelled"; });
    const snapshot = nativeResourceInput([3, 8], { nativeRecords: [...nativeFixture(3, 8), cancelled] });
    const active = aggregateResources([snapshot]);
    const terminal = aggregateResources([{ ...snapshot, canEmitNativeRecords: false }]);
    expect(active.trajectory.turns.cancelled).toBe(1);
    expect(active.trajectory.tools).toMatchObject({ count: { value: 1, coverage: "partial" }, inProgress: 1, unknown: 0 });
    expect(terminal.trajectory.tools).toMatchObject({ count: { value: 1, coverage: "partial" }, inProgress: 0, unknown: 1 });
  });

  it("does not select an arbitrary winner for contradictory Tool outcomes and names", () => {
    const differentOutcome = variant(11, 17, (event) => { (event.payload as Record<string, unknown>).outcome = "completed"; });
    const differentName = variant(8, 18, (event) => { (event.payload as Record<string, unknown>).toolName = "shell"; });
    const lateReplay = variant(11, 19, () => {});
    const result = aggregateResources([nativeResourceInput([], { nativeRecords: [
      ...nativeFixture(...Array.from({ length: 16 }, (_, index) => index + 1)), differentOutcome, differentName, lateReplay,
    ] })]);
    expect(result.trajectory.tools).toMatchObject({ count: { value: 1, coverage: "partial" }, unknown: 1, completed: 0 });
    expect(result.trajectory.byTool.some((item) => item.toolName === null)).toBe(true);
    expect(result.diagnostics.filter((item) => item.kind === "conflicting-identity").length).toBeGreaterThanOrEqual(2);
  });

  it("diagnoses unsupported and unidentifiable native record facts", () => {
    const future = variant(3, 3, (event) => { event.type = "future-event"; });
    const missingCallId = variant(8, 8, (event) => { delete event.toolCallId; });
    const result = aggregateResources([nativeResourceInput([], { nativeRecords: [future, missingCallId] })]);
    expect(result.modelRequests.count.value).toBeNull();
    expect(result.diagnostics.map((item) => item.kind)).toEqual(["unsupported-record", "missing-identity"]);
  });

  it.each([-1, 0.5, "10", Number.MAX_SAFE_INTEGER + 1, null])("does not coerce invalid or absent token value %s", (inputTokens) => {
    const result = aggregateResources([resourceInput({ usageEvents: [usage("usage-1", { metrics: { inputTokens } })] })]);
    expect(result.tokens.input.value).toBeNull();
    expect(result.tokens.total.value).toBeNull();
    if (inputTokens !== null) expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "invalid-value" }));
  });

  it("diagnoses unsafe token sums instead of returning rounded integers", () => {
    const result = aggregateResources([resourceInput({ usageEvents: [
      usage("large", { metrics: { totalTokens: Number.MAX_SAFE_INTEGER } }), usage("small", { metrics: { totalTokens: 1 } }),
    ] })]);
    expect(result.tokens.total).toEqual({ value: null, coverage: "unavailable" });
    expect(result.diagnostics.some((item) => item.message.includes("safe number range"))).toBe(true);
  });

  it("never mutates original facts or leaks diagnostic scope references", () => {
    const unknown: AgentResourceFact = { eventId: "unknown", runId: "run-1", kind: "new-kind" };
    const input = [resourceInput({ usageEvents: [usage("usage-1"), unknown] })];
    const before = structuredClone(input);
    const result = aggregateResources(input);
    expect(input).toEqual(before);
    Object.assign(result.diagnostics[0]!.scope, { submissionId: "changed" });
    expect(input).toEqual(before);
  });
});
