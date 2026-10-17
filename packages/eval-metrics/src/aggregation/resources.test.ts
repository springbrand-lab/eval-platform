import { describe, expect, it } from "vitest";
import type { AgentResourceFact, AgentResourceScope } from "@eval-platform/eval-contracts";
import { resourceInput, settlement, telemetry, usage } from "../test-support.js";
import { aggregateResources } from "./resources.js";

const SCOPE = { chatId: "subject-chat", submissionId: "subject-submission", idempotencyKey: "execution:sampling-1" } satisfies AgentResourceScope;

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
      usageEvents: [usage("usage-1")], coverage: { usageEvents: coverage, telemetryEvents: coverage, billingSettlements: coverage },
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
    const started = telemetry("tool-start", "tool.started", "tool-1", { toolName: "browser" });
    const result = aggregateResources([
      resourceInput({ usageEvents: [event, reordered], telemetryEvents: [started], billingSettlements: [settlement("usage-1")] }),
      resourceInput({ usageEvents: [event], telemetryEvents: [{ ingestSeq: 123, event: started }], billingSettlements: [settlement("usage-1")] }),
    ]);
    expect(result.tokens.total.value).toBe(35);
    expect(result.trajectory.tools.count.value).toBe(1);
    expect(result.costs.modelDebitedUnits.value).toBe(8);
    expect(result.duplicateRecords).toEqual({ usageEvents: 2, telemetryEvents: 1, billingSettlements: 1 });
  });

  it("keeps different users, accounts and sessions with the same local ID separate", () => {
    const result = aggregateResources([
      resourceInput({ usageEvents: [usage("shared")], telemetryEvents: [telemetry("shared", "generation.started", "op-1")], billingSettlements: [settlement("shared")] }),
      resourceInput({ usageEvents: [usage("shared")], telemetryEvents: [telemetry("shared", "generation.started", "op-1", {}, 100, "session-2")], billingSettlements: [settlement("shared", { accountId: "account-2" })] }, "owner-2"),
    ]);
    expect(result.tokens.total.value).toBe(70);
    expect(result.modelRequests.count.value).toBe(2);
    expect(result.costs.modelDebitedUnits.value).toBe(16);
    expect(result.duplicateRecords).toEqual({ usageEvents: 0, telemetryEvents: 0, billingSettlements: 0 });
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
    const result = aggregateResources([resourceInput({
      usageEvents: [{ kind: "assistant_model", metrics: { inputTokens: 1 } }, usage("unsupported", { kind: "new-kind" })],
      telemetryEvents: [{ eventId: "missing-session", type: "tool.started", operationId: "tool-1" }],
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
    const result = aggregateResources([resourceInput({
      usageEvents: [usage("usage-1")],
      telemetryEvents: [telemetry("tool-1", "tool.finished", "tool-1", { toolName: "action", outcome: "completed", cost: 9_999 })],
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

  it("counts one turn with multiple model requests and pairs tool calls regardless of event order", () => {
    const events = [
      telemetry("turn-start", "turn.started", "turn-1", {}, 0),
      telemetry("turn-end", "turn.finished", "turn-1", { outcome: "completed" }, 500),
      telemetry("request-1-start", "generation.started", "request-1", {}, 1),
      telemetry("request-1-end", "generation.finished", "request-1", { outcome: "completed" }, 11),
      telemetry("request-2-start", "generation.started", "request-2", {}, 100),
      telemetry("request-2-end", "generation.finished", "request-2", { outcome: "failed" }, 120),
      telemetry("tool-start", "tool.started", "tool-1", { toolName: "browser" }, 200),
      telemetry("tool-end", "tool.finished", "tool-1", { toolName: "browser", outcome: "completed" }, 240),
    ];
    const result = aggregateResources([resourceInput({ telemetryEvents: events.toReversed() })]);
    expect(result.trajectory.turns).toMatchObject({ count: { value: 1, coverage: "complete" }, completed: 1, durationMs: { mean: 500 } });
    expect(result.modelRequests).toMatchObject({ count: { value: 2, coverage: "complete" }, completed: 1, failed: 1, durationMs: { mean: 15 } });
    expect(result.trajectory.tools).toMatchObject({ count: { value: 1, coverage: "complete" }, completed: 1, durationMs: { mean: 40 } });
    expect(result.trajectory.byTool[0]).toMatchObject({ toolName: "browser", count: { value: 1 }, durationMs: { total: 40 } });
  });

  it("keeps cancelled, unknown and in-progress operations distinct", () => {
    const result = aggregateResources([resourceInput({ telemetryEvents: [
      telemetry("cancel", "turn.cancelled", "turn-1"),
      telemetry("unknown", "tool.finished", "tool-1", { toolName: "browser", durationMs: 7 }),
      telemetry("start", "tool.started", "tool-2", { toolName: "browser" }),
      telemetry("other", "approval.requested", "approval-1"),
    ] })]);
    expect(result.trajectory.turns.cancelled).toBe(1);
    expect(result.trajectory.tools).toMatchObject({ count: { value: 2 }, unknown: 1, inProgress: 1, failed: 0, durationMs: { count: 1, missing: 1, mean: 7 } });
  });

  it("does not select an arbitrary winner for contradictory operation kind, outcome or tool name", () => {
    const result = aggregateResources([resourceInput({ telemetryEvents: [
      telemetry("kind-1", "turn.started", "conflicting-kind"), telemetry("kind-2", "tool.started", "conflicting-kind"),
      telemetry("outcome-1", "tool.finished", "conflicting-outcome", { toolName: "browser", outcome: "completed", durationMs: 10 }),
      telemetry("outcome-2", "tool.finished", "conflicting-outcome", { toolName: "browser", outcome: "failed", durationMs: 20 }),
      telemetry("name-1", "tool.started", "conflicting-name", { toolName: "browser" }),
      telemetry("name-2", "tool.finished", "conflicting-name", { toolName: "shell", outcome: "completed" }),
    ] })]);
    expect(result.trajectory.tools).toMatchObject({ count: { value: 2, coverage: "partial" }, unknown: 1, completed: 1 });
    expect(result.trajectory.turns.count.value).toBeNull();
    expect(result.trajectory.byTool.find((item) => item.toolName === "browser")!.durationMs.count).toBe(0);
    expect(result.trajectory.byTool.some((item) => item.toolName === null)).toBe(true);
    expect(result.diagnostics.filter((item) => item.kind === "conflicting-identity")).toHaveLength(3);
  });

  it("diagnoses unsupported and unidentifiable operation events", () => {
    const result = aggregateResources([resourceInput({ telemetryEvents: [
      telemetry("unknown", "generation.future-event", "request-1"),
      { ...telemetry("missing-operation", "tool.started", "request-1"), operationId: null },
    ] })]);
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
