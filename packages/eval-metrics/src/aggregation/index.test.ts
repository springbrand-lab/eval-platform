import { describe, expect, it } from "vitest";
import type { SamplingStatus } from "@eval-platform/eval-contracts";
import { createEvaluationOutputReader } from "../evaluators/index.js";
import { collection, evaluation, OUTPUT_SCHEMA, sampling, SCHEMA_REF, settlement, usage } from "../test-support.js";
import { evaluatorAgent, subjectAgent } from "./agents.js";
import { aggregateMetrics, type MetricInput } from "./index.js";
import { summarizeNumbers } from "./statistics.js";

const BINDINGS = { datasets: 1, data: 1, projectSamples: 1 };
const summarize = (input: Pick<MetricInput, "samplings" | "evaluations">) => aggregateMetrics({
  ...input, bindings: BINDINGS, outputs: createEvaluationOutputReader(SCHEMA_REF, OUTPUT_SCHEMA),
});

describe("numeric summaries", () => {
  it("keeps missing/non-finite observations out of the denominator", () => {
    expect(summarizeNumbers([0, 10, 20, null, NaN, Infinity])).toEqual({
      count: 3, missing: 3, total: 30, min: 0, max: 20, mean: 10, median: 10,
    });
    expect(summarizeNumbers([null])).toEqual({ count: 0, missing: 1, total: null, min: null, max: null, mean: null, median: null });
  });

  it("handles negative values and even-sized medians without sorting the input", () => {
    const input = [30, -10, 20, 0];
    expect(summarizeNumbers(input)).toEqual({ count: 4, missing: 0, total: 40, min: -10, max: 30, mean: 10, median: 10 });
    expect(input).toEqual([30, -10, 20, 0]);
  });

  it("rejects overflow rather than returning an infinite aggregate", () => {
    expect(() => summarizeNumbers([Number.MAX_VALUE, Number.MAX_VALUE])).toThrow(RangeError);
  });
});

describe("execution/evaluation aggregation", () => {
  it("keeps every stage status and uses only terminal records for the success rate", () => {
    const statuses: SamplingStatus[] = ["queued", "starting", "running", "retrying", "succeeded", "failed", "cancelled"];
    const samplings = statuses.map((status) => sampling(`sampling:${status}`, { execution: { status }, executionAttempts: [] }));
    const result = summarize({ samplings, evaluations: [] });
    expect(result.counts).toEqual({ ...BINDINGS, samplings: 7, evaluations: 0 });
    expect(result.execution).toMatchObject({
      records: 7, statuses: { queued: 1, starting: 1, running: 1, retrying: 1, succeeded: 1, failed: 1, cancelled: 1 },
      terminalRecords: 3, successRate: 1 / 3, attempts: 0, restarts: 0,
    });
    expect(result.evaluation.successRate).toBeNull();
    expect(result.execution.agentDurationMs).toMatchObject({ count: 0, missing: 7, total: null });
    expect(result.executionAgent.tokens.total).toEqual({ value: null, coverage: "unavailable" });
  });

  it("does not call a completed agent failed when runtime finalization failed", () => {
    const result = summarize({
      samplings: [sampling("sampling-1", { execution: { status: "failed", lastError: "Database write failed" } })],
      evaluations: [evaluation("evaluation-1", { status: { status: "failed", lastError: "Output persistence failed" } })],
    });
    expect(result.execution).toMatchObject({ statuses: { failed: 1 }, completedAttempts: 1, failedAttempts: 0, successRate: 0 });
    expect(result.evaluation).toMatchObject({ statuses: { failed: 1 }, completedAttempts: 1, failedAttempts: 0 });
    expect(result.numericOutputs.fields[0]).toMatchObject({ jsonPointer: "/score", observationCount: 0, diagnostics: [{ reason: "not-succeeded", evaluations: 1 }] });
  });

  it("keeps Subject and Evaluator resources separate and counts failed, cancelled and restarted attempts", () => {
    const subject = sampling();
    const judge = evaluation();
    const result = summarize({ samplings: [{ ...subject, executionAttempts: [
      { ...subject.executionAttempts[0]!, status: "failed", resources: collection({ usageEvents: [usage("failed", { metrics: { totalTokens: 10 } })] }) },
      { ...subject.executionAttempts[0]!, executionAttemptId: "restart-1", attemptNumber: 2, status: "completed", resources: collection({ usageEvents: [usage("completed", { metrics: { totalTokens: 20 } })] }) },
    ] }], evaluations: [{ ...judge, status: { status: "failed" }, attempts: [
      { ...judge.attempts[0]!, status: "interrupted", resources: collection({ usageEvents: [usage("interrupted", { metrics: { totalTokens: 40 } })] }) },
      { ...judge.attempts[0]!, evaluationAttemptId: "restart-2", attemptNumber: 2, status: "cancelled", resources: collection({ usageEvents: [usage("cancelled", { metrics: { totalTokens: 80 } })] }) },
    ] }] });
    expect(result.execution).toMatchObject({ attempts: 2, restarts: 1, failedAttempts: 1, completedAttempts: 1 });
    expect(result.evaluation).toMatchObject({ attempts: 2, restarts: 1, interruptedAttempts: 1, cancelledAttempts: 1 });
    expect(result.executionAgent.tokens.total.value).toBe(30);
    expect(result.evaluationAgents.tokens.total.value).toBe(120);
    expect(result).not.toHaveProperty("resources");
  });

  it("measures agent spans including restart gaps separately from attempt durations", () => {
    const subject = sampling();
    const attempts = [
      { ...subject.executionAttempts[0]!, status: "failed" as const },
      { ...subject.executionAttempts[0]!, executionAttemptId: "restart", attemptNumber: 2, startedAt: "2026-10-08T00:00:03.000Z", completedAt: "2026-10-08T00:00:05.000Z" },
    ];
    const result = summarize({ samplings: [{ ...subject, executionAttempts: attempts }, sampling("sampling-2")], evaluations: [] });
    expect(result.execution.agentDurationMs).toEqual({ count: 2, missing: 0, total: 6_000, min: 1_000, max: 5_000, mean: 3_000, median: 3_000 });
    expect(result.execution.attemptDurationMs).toMatchObject({ count: 3, total: 4_000 });
    expect(result).not.toHaveProperty("runDurationMs");
  });

  it.each([
    { startedAt: "not-a-date" },
    { completedAt: "not-a-date" },
    { completedAt: "2026-10-07T23:59:59.000Z" },
    { status: "running" as const },
  ])("keeps invalid, reversed or unfinished attempt timestamps out of duration statistics: %j", (patch) => {
    const subject = sampling();
    const result = summarize({ samplings: [{ ...subject, executionAttempts: [{ ...subject.executionAttempts[0]!, ...patch }] }], evaluations: [] });
    expect(result.execution.agentDurationMs).toMatchObject({ count: 0, missing: 1, total: null });
  });

  it("rejects duplicate and orphan identities before counting", () => {
    expect(() => summarize({ samplings: [sampling(), sampling()], evaluations: [] })).toThrow("Duplicate Sampling");
    expect(() => summarize({ samplings: [sampling()], evaluations: [evaluation(), evaluation()] })).toThrow("Duplicate Evaluation");
    expect(() => summarize({ samplings: [], evaluations: [evaluation()] })).toThrow("Sampling scope");
  });
});

describe("agent views", () => {
  it("shows the Subject with its Chat, attempts, span, deduplicated resources and evidence", () => {
    const base = sampling();
    const shared = collection({
      usageEvents: [usage("u1")], billingSettlements: [settlement("u1"), { executionId: "action-1", status: "succeeded", chargedCredits: 5 }],
    });
    const view = subjectAgent({ ...base, executionAttempts: [
      { ...base.executionAttempts[0]!, status: "failed", resources: shared },
      { ...base.executionAttempts[0]!, executionAttemptId: "a2", attemptNumber: 2, startedAt: "2026-10-08T00:00:02.000Z",
        completedAt: "2026-10-08T00:00:04.000Z", resources: shared },
    ] });
    expect(view).toMatchObject({
      role: "subject", agentConfigRef: base.subjectAgent, chatId: "subject:sampling-1", evaluationId: null,
      attempts: { count: 2, restarts: 1 }, firstStartedAt: "2026-10-08T00:00:00.000Z",
      lastCompletedAt: "2026-10-08T00:00:04.000Z", agentDurationMs: 4_000,
      artifacts: base.artifacts, trajectory: base.trajectory,
    });
    expect(view.attempts.items.map((item) => item.durationMs)).toEqual([1_000, 2_000]);
    expect(view.resources.tokens).toMatchObject({ input: { value: 10 }, cacheRead: { value: 3 }, cacheWrite: { value: 2 }, reasoning: { value: 4 }, total: { value: 35 } });
    expect(view.resources.costs).toMatchObject({
      providerUsd: { value: 0.5 }, modelDebitedUnits: { value: 8 }, actionChargedUnits: { value: 5 },
      ratedUnits: { value: 10 }, shortfallUnits: { value: 2 }, platformOwnedUnits: { value: 2 },
    });
    expect(view.resources.coverage).toBe("complete");
  });

  it("separates each Evaluator and reports a submitted Attempt without resources as a gap", () => {
    const { resources: _resources, submissionId: _submission, completedAt: _completed, ...attempt } = evaluation().attempts[0]!;
    const record = evaluation("evaluation-9", { attempts: [{ ...attempt, submissionId: "s", completedAt: "2026-10-08T00:00:04.000Z" }] });
    const view = evaluatorAgent(record);
    expect(view).toMatchObject({ role: "evaluator", chatId: "judge:evaluation-9", evaluationId: "evaluation-9", samplingId: "sampling-1" });
    expect(view.attempts.items[0]!.resourceCollection).toBe("uncollected");
    expect(view.resources).toMatchObject({ coverage: "unavailable", collections: { uncollected: 1 } });
    const unsubmitted = evaluatorAgent(evaluation("e", { status: { status: "queued" }, attempts: [{ ...attempt, status: "queued" }] }));
    expect(unsubmitted.attempts.items[0]!.resourceCollection).toBe("unsubmitted");
    expect(unsubmitted).toMatchObject({ lastCompletedAt: null, agentDurationMs: null });
  });
});
