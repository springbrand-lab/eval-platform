import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createRoutes } from "../app.js";
import { EVAL_MANAGEMENT_MCP_PATH } from "./mcp.js";
import { MANAGEMENT_TOKEN, run, setupManagement, toolValue } from "./test-fixture.js";

const scope = { projectId: "project-1", samplingId: "sampling-1", role: "execution" as const };
const attempt = {
  attemptId: "attempt-1", attemptNumber: "1", status: "completed", resourcesStatus: "collected",
  finalized: "false", usageCoverage: "partial", nativeCoverage: "complete", billingCoverage: "partial",
  actionsComplete: "false", unsettledExecutions: "2", missingExecutionIds: "1",
  accountId: "private-account", chatId: "private-chat", toolArguments: "private Tool arguments",
};

describe("get_case_usage over the authenticated management tools/call seam", () => {
  it("pages current Attempts, distinguishing pending from collected without hydrating Metrics or raw snapshots", async () => {
    const app = setupManagement();
    app.services.resourceSnapshots.readCaseUsage.mockResolvedValueOnce({ total: 3, attempt: null,
      rows: [attempt, { ...attempt, attemptId: "attempt-2", resourcesStatus: "pending" }] });
    const value = await toolValue(await app.call("get_case_usage", { ...scope, pageSize: 2 }));
    expect(value).toMatchObject({ ...scope, runScope: "project_current", section: "attempts",
      attempts: { page: 1, pageSize: 2, total: 3, items: [
        { attemptId: "attempt-1", resources: { status: "collected", finalized: false,
          coverage: { usageEvents: "partial", billingSettlements: "partial" },
          actionCharges: { complete: false, unsettledExecutions: 2, missingExecutionIds: 1 } } },
        { attemptId: "attempt-2", resources: { status: "pending", finalized: null,
          coverage: { usageEvents: "unavailable" }, actionCharges: { complete: null } } },
      ] } });
    expect(app.services.resourceSnapshots.readCaseUsage).toHaveBeenCalledExactlyOnceWith({
      ...scope, section: "attempts", page: 1, pageSize: 2,
    });
    expect(app.services.metrics.getSamplingDetail).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).not.toMatch(/private|accountId|chatId|toolArguments/u);
  });

  it("separates cache ratio, token buckets and provider USD from paired/partial/unsettled billed credits", async () => {
    const app = setupManagement();
    app.services.resourceSnapshots.readCaseUsage.mockResolvedValueOnce({ total: 4, attempt, rows: [
      { index: 1, eventId: "usage-1", kind: "assistant_model", provider: "provider", model: "model-1",
        inputTokens: "30", outputTokens: "12", cacheReadTokens: "10", cacheWriteTokens: "1",
        reasoningTokens: "3", providerUsd: "0.005", usageMatches: 1, settlementMatches: 1,
        accountPresent: true, status: "settled", ratedUnits: "9", debitedUnits: "4",
        shortfallUnits: "5", platformOwnedUnits: "2", snapshot: "private raw snapshot" },
      { index: 2, eventId: "usage-2", kind: "compaction", provider: "https://private.test",
        model: "sk-veryprivatecredential", usageMatches: 1, settlementMatches: 1,
        accountPresent: true, status: "settled", ratedUnits: "3", debitedUnits: null },
      { index: 3, eventId: "usage-3", kind: "chat_title", usageMatches: 1,
        settlementMatches: 1, accountPresent: true, status: "running", debitedUnits: "1000" },
      { index: 4, eventId: "usage-4", usageMatches: 2,
        settlementMatches: 1, accountPresent: true, status: "settled", debitedUnits: "1000" },
    ] });
    const value = await toolValue(await app.call("get_case_usage", {
      ...scope, section: "models", attemptId: "attempt-1",
    }));
    expect(value).toMatchObject({ availability: "available",
      attempt: { resources: { coverage: { usageEvents: "partial", billingSettlements: "partial" } } },
      models: { total: 4, items: [
        { tokens: { input: 30, output: 12, cacheRead: 10, cacheWrite: 1, total: 53 },
          cacheHitRate: { value: 0.25, coverage: "partial" }, providerUsdEstimate: 0.005,
          modelSettlement: { state: "settled", ratedCredits: 9, debitedCredits: 4,
            shortfallCredits: 5, platformOwnedCredits: 2 } },
        { provider: null, model: null, modelSettlement: { state: "partial", ratedCredits: 3, debitedCredits: null } },
        { modelSettlement: { state: "unsettled", debitedCredits: null } },
        { modelSettlement: { state: "ambiguous", debitedCredits: null } },
      ] } });
    expect(JSON.stringify(value)).not.toMatch(/private|https:|sk-very|accountId|snapshot|chatId/u);
  });

  it("never treats an anomalous settlement as a confirmed debit", async () => {
    const app = setupManagement();
    app.services.resourceSnapshots.readCaseUsage.mockResolvedValueOnce({ total: 1, attempt, rows: [{
      index: 1, eventId: "usage-anomaly", kind: "assistant_model", usageMatches: 1,
      settlementMatches: 1, accountPresent: true, status: "anomaly",
      ratedUnits: "9", debitedUnits: "7", shortfallUnits: "2", platformOwnedUnits: "0",
    }] });
    const value = await toolValue(await app.call("get_case_usage", {
      ...scope, section: "models", attemptId: "attempt-1",
    }));
    expect(value).toMatchObject({ models: { items: [{
      modelSettlement: { state: "partial", status: "anomaly",
        ratedCredits: null, debitedCredits: null, shortfallCredits: null, platformOwnedCredits: null },
    }] } });
  });

  it("only shows verified Action charges and marks missing/unknown snapshot reads as unavailable", async () => {
    const app = setupManagement();
    app.services.resourceSnapshots.readCaseUsage.mockResolvedValueOnce({ total: 5, attempt, rows: [
      { index: 1, executionId: "action-1", status: "succeeded", chargedCredits: "7", executionMatches: 1 },
      { index: 2, executionId: "action-2", status: "outcome_unknown", chargedCredits: "0", executionMatches: 1 },
      { index: 3, executionId: null, status: "failed", chargedCredits: "99", executionMatches: 0,
        toolArguments: "private Tool arguments" },
      { index: 4, executionId: "action-4", status: "succeeded", chargedCredits: "99", executionMatches: 2 },
      { index: 5, executionId: "action-5", status: "failed", chargedCredits: "0", executionMatches: 1 },
    ] }).mockResolvedValueOnce({ total: null, attempt: { ...attempt, resourcesStatus: "failed" }, rows: [] })
      .mockResolvedValueOnce({ total: null, attempt, rows: [] });
    const actions = await toolValue(await app.call("get_case_usage", {
      ...scope, section: "actions", attemptId: "attempt-1",
    }));
    expect(actions).toMatchObject({ availability: "available",
      attempt: { resources: { actionCharges: { complete: false, missingExecutionIds: 1 } } },
      actions: { total: 5, items: [
        { chargedCredits: 7, chargeState: "observed", toolName: null, capabilityId: null, matchState: "unavailable" },
        { chargedCredits: null, chargeState: "unconfirmed", matchState: "unavailable" },
        { chargedCredits: null, chargeState: "unconfirmed", matchState: "unavailable" },
        { chargedCredits: null, chargeState: "unconfirmed", matchState: "ambiguous" },
        { chargedCredits: 0, chargeState: "observed", matchState: "unavailable" },
      ] } });
    expect(JSON.stringify(actions)).not.toMatch(/private|toolArguments/u);
    const select = { ...scope, section: "models", attemptId: "attempt-1" };
    expect(await toolValue(await app.call("get_case_usage", select))).toMatchObject({
      availability: "not_collected", models: { total: null, items: [] } });
    expect(await toolValue(await app.call("get_case_usage", select))).toMatchObject({
      availability: "snapshot_missing", models: { total: null, items: [] } });
  });

  it("logs bounded Action-link counts without exposing source identities or Tool data", async () => {
    const app = setupManagement();
    const privateValue = "PRIVATE_TRACE_DO_NOT_LOG";
    const inventory = {
      snapshotNativeRows: "328", scopedNativeRows: "328", rawRoleToolResults: "0",
      scopedPiToolResults: "45", compactedPiToolResults: "45", supportedPiToolResults: "45",
      projectedPiToolResults: "45", projectedExecutionIds: "0",
      linkableToolCalls: "45", linkableToolResults: "0",
    };
    app.services.resourceSnapshots.readCaseUsage.mockResolvedValueOnce({ total: 2, attempt, rows: [
      { ...inventory, index: 1, executionId: "action-1", billingSource: "tool",
        status: "succeeded", chargedCredits: "7",
        executionMatches: 1, linkMatches: 0, toolCallMatches: 0, namedToolCallMatches: 0,
        resultCallMatches: 0, legacyCompact: false, toolName: `https://${privateValue}/tool`,
        details: { credential: privateValue }, accountId: privateValue },
      { ...inventory, index: 2, executionId: "action-2", billingSource: "action",
        status: "succeeded", chargedCredits: "4",
        executionMatches: 1, linkMatches: 1, toolCallMatches: 1, namedToolCallMatches: 1,
        resultCallMatches: 1, legacyCompact: false, toolName: "execute_capability",
        capabilityId: "action.send-invoice" },
    ] });
    const logs: Record<string, unknown>[] = [];
    const logger = pino({ level: "info" }, {
      write: (line: string) => { logs.push(JSON.parse(line) as Record<string, unknown>); },
    });
    const response = await createRoutes(logger).request(EVAL_MANAGEMENT_MCP_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "get_case_usage", arguments: { ...scope, section: "actions", attemptId: "attempt-1", pageSize: 2 },
      } }),
    }, app.runtime);
    const value = await toolValue(response);
    expect(value.actions).toMatchObject({ total: 2, items: [
      { chargedCredits: 7, matchState: "unavailable", toolName: null },
      { chargedCredits: 4, matchState: "matched", toolName: "execute_capability" },
    ] });
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE_TRACE_DO_NOT_LOG|snapshotNativeRows|linkMatches|billingSource/u);
    expect(logs.filter((entry) => entry.event === "eval_case_action_link_diagnostics")).toEqual([
      expect.objectContaining({
        page: 1, pageSize: 2, total: 2, nativeCoverage: "complete",
        matchStates: { matched: 1, ambiguous: 0, unavailable: 1, unknown: 0 },
        billingSources: { action: 1, tool: 1, missing: 0, other: 0 },
        resultLinks: { none: 1, one: 1, multiple: 0, missing: 0 },
        inventory: {
          snapshotNativeRows: 328, scopedNativeRows: 328, rawRoleToolResults: 0,
          scopedPiToolResults: 45, compactedPiToolResults: 45, supportedPiToolResults: 45,
          projectedPiToolResults: 45, projectedExecutionIds: 0,
          linkableToolCalls: 45, linkableToolResults: 0,
        },
      }),
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/PRIVATE_TRACE_DO_NOT_LOG|action-1|action-2|action\.send-invoice/u);
  });

  it("links a unique charged Action to a SAFE Tool Result only with one matching scoped Tool Call", async () => {
    const app = setupManagement();
    const linked = { index: 1, executionId: "execution-1", status: "succeeded",
      chargedCredits: "7", executionMatches: 1,
      linkMatches: 1, toolCallMatches: 1, namedToolCallMatches: 1, resultCallMatches: 1,
      legacyCompact: false, toolName: "api.search", capabilityId: "capability-1",
      agentId: "private-actor", submissionId: "private-submission", toolCallId: "private-call",
      accountId: "private-account", details: { credential: "private-key" } };
    app.services.resourceSnapshots.readCaseUsage.mockResolvedValueOnce({
      total: 1, attempt, rows: [linked],
    });
    const result = await toolValue(await app.call("get_case_usage", {
      ...scope, section: "actions", attemptId: "attempt-1",
    }));
    expect(result).toMatchObject({ actions: { items: [{
      executionId: "execution-1", status: "succeeded", chargedCredits: 7, chargeState: "observed",
      toolName: "api.search", capabilityId: "capability-1", matchState: "matched",
    }] } });
    expect(JSON.stringify(result)).not.toMatch(/private|agentId|submissionId|toolCallId|accountId|details/u);
  });

  it("does not attribute duplicate, mismatched or historical unlinked Tool Results to a charge", async () => {
    const app = setupManagement();
    const linked = { executionId: "execution-1", status: "failed", chargedCredits: "0",
      executionMatches: 1, linkMatches: 1, toolCallMatches: 1, namedToolCallMatches: 1,
      resultCallMatches: 1, legacyCompact: false, toolName: "api.search", capabilityId: "capability-1" };
    const rows = [
      { ...linked, index: 1, executionMatches: 2 },
      { ...linked, index: 2, linkMatches: 2 },
      { ...linked, index: 3, toolCallMatches: 2 },
      { ...linked, index: 4, namedToolCallMatches: 0 },
      { ...linked, index: 5, resultCallMatches: 2 },
      { ...linked, index: 6, toolCallMatches: 0 },
      { ...linked, index: 7, linkMatches: 0, legacyCompact: true },
      { ...linked, index: 8, legacyCompact: true },
      { ...linked, index: 9, linkMatches: 0 },
      { ...linked, index: 10, toolName: "sk-private-token" },
    ];
    app.services.resourceSnapshots.readCaseUsage.mockResolvedValueOnce({ total: 10, attempt, rows });
    const result = await toolValue(await app.call("get_case_usage", {
      ...scope, section: "actions", attemptId: "attempt-1", pageSize: 10,
    }));
    expect((result.actions as { items: Record<string, unknown>[] }).items.map((item) =>
      [item.matchState, item.toolName, item.capabilityId])).toEqual([
      ["ambiguous", null, null], ["ambiguous", null, null],
      ["ambiguous", null, null], ["ambiguous", null, null], ["ambiguous", null, null],
      ["unavailable", null, null], ["unknown", null, null], ["unknown", null, null],
      ["unavailable", null, null], ["unavailable", null, null],
    ]);
    expect((result.actions as { items: Record<string, unknown>[] }).items[7]).toMatchObject({
      chargedCredits: 0, chargeState: "observed",
    });
  });

  it("reports an incomplete native inventory as unknown without losing a settled Action debit", async () => {
    const app = setupManagement();
    app.services.resourceSnapshots.readCaseUsage.mockResolvedValueOnce({
      total: 1, attempt: { ...attempt, nativeCoverage: "partial" }, rows: [{
        index: 1, executionId: "execution-1", status: "succeeded", chargedCredits: "3",
        executionMatches: 1, linkMatches: 1, toolCallMatches: 1, namedToolCallMatches: 1,
        resultCallMatches: 1, legacyCompact: false, toolName: "api.search", capabilityId: "capability-1",
      }],
    });
    expect(await toolValue(await app.call("get_case_usage", {
      ...scope, section: "actions", attemptId: "attempt-1",
    }))).toMatchObject({ attempt: { resources: { coverage: { nativeRecords: "partial" } } },
      actions: { items: [{ chargedCredits: 3, chargeState: "observed",
        toolName: null, capabilityId: null, matchState: "unknown" }] } });
  });

  it("validates role/selection before SQL, fails closed on nonmembers and rejects an unauthenticated caller", async () => {
    const app = setupManagement();
    for (const invalid of [{ role: "evaluation" }, { evaluationId: "evaluation-1" },
      { section: "models" }, { section: "attempts", attemptId: "attempt-1" },
      { pageSize: 11 }, { accountId: "private" }]) {
      expect(await (await app.call("get_case_usage", { ...scope, ...invalid })).json())
        .toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("REQUEST_INVALID_INPUT") }] } });
    }
    expect(app.services.resourceSnapshots.readCaseUsage).not.toHaveBeenCalled();
    const selected = { ...scope, role: "evaluation", evaluationId: "evaluation-1", runId: run.runId };
    app.services.resourceSnapshots.readCaseUsage.mockResolvedValueOnce({ total: 0, rows: [], attempt: null });
    expect(await toolValue(await app.call("get_case_usage", selected))).toMatchObject({
      runScope: "exact_run", runId: run.runId, attempts: { total: 0 } });
    app.services.resourceSnapshots.readCaseUsage
      .mockRejectedValueOnce(new HttpError("EVALUATION_NOT_FOUND"))
      .mockRejectedValueOnce(new HttpError("SAMPLING_NOT_FOUND"));
    for (const other of [{ ...selected, evaluationId: "other" },
      { ...scope, runId: run.runId, samplingId: "other" }]) {
      expect(await (await app.call("get_case_usage", other)).json()).toMatchObject({ result: { isError: true,
        content: [{ text: expect.stringContaining("_NOT_FOUND") }] } });
    }
    expect(app.services.projectRuns.readRun).not.toHaveBeenCalled();
    expect(app.services.observations.evaluator).not.toHaveBeenCalled();
    const denied = await app.rpc({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "get_case_usage", arguments: scope } }, MANAGEMENT_TOKEN.slice(0, 10));
    expect(denied.status).toBe(401);
  });
});
