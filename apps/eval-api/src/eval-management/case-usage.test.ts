import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { describe, expect, it } from "vitest";
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
        { chargedCredits: 7, chargeState: "observed" },
        { chargedCredits: null, chargeState: "unconfirmed" },
        { chargedCredits: null, chargeState: "unconfirmed" },
        { chargedCredits: null, chargeState: "unconfirmed" },
        { chargedCredits: 0, chargeState: "observed" },
      ] } });
    expect(JSON.stringify(actions)).not.toMatch(/private|toolArguments/u);
    const select = { ...scope, section: "models", attemptId: "attempt-1" };
    expect(await toolValue(await app.call("get_case_usage", select))).toMatchObject({
      availability: "not_collected", models: { total: null, items: [] } });
    expect(await toolValue(await app.call("get_case_usage", select))).toMatchObject({
      availability: "snapshot_missing", models: { total: null, items: [] } });
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
