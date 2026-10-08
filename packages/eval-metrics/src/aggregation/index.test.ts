import { describe, expect, it } from "vitest";
import type { SamplingStatus } from "@eval-platform/eval-contracts";
import { collection, evaluation, sampling, usage } from "../test-support.js";
import { aggregateMetrics, summarizeNumbers } from "./index.js";

describe("numeric summaries", () => {
  it("keeps missing/non-finite observations out of the denominator", () => {
    expect(summarizeNumbers([0, 10, 20, null, NaN, Infinity])).toEqual({
      count: 3, missing: 3, total: 30, min: 0, max: 20, mean: 10, median: 10,
    });
    expect(summarizeNumbers([null])).toEqual({ count: 0, missing: 1, total: null, min: null, max: null, mean: null, median: null });
  });

  it("handles negative scores and even-sized medians without sorting the input", () => {
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
    const result = aggregateMetrics({ samplings, evaluations: [] });
    expect(result.execution).toMatchObject({
      records: 7, statuses: { queued: 1, starting: 1, running: 1, retrying: 1, succeeded: 1, failed: 1, cancelled: 1 },
      terminalRecords: 3, successRate: 1 / 3, attempts: 0, restarts: 0,
    });
    expect(result.evaluation.successRate).toBeNull();
    expect(result.execution.agentDurationMs).toMatchObject({ count: 0, missing: 7, total: null });
  });

  it("does not call a completed agent failed when runtime finalization failed", () => {
    const result = aggregateMetrics({
      samplings: [sampling("sampling-1", { execution: { status: "failed", lastError: "Database write failed" } })],
      evaluations: [evaluation("evaluation-1", { status: { status: "failed", lastError: "Output persistence failed" } })],
    });
    expect(result.execution).toMatchObject({ statuses: { failed: 1 }, completedAttempts: 1, failedAttempts: 0, successRate: 0 });
    expect(result.evaluation).toMatchObject({ statuses: { failed: 1 }, completedAttempts: 1, failedAttempts: 0 });
    expect(result.scores[0]!.scores.mean).toBe(80);
  });

  it("retains failures, cancellation and interruptions in resource totals across restarts", () => {
    const subject = sampling();
    const judge = evaluation();
    const result = aggregateMetrics({ samplings: [{ ...subject, executionAttempts: [
      { ...subject.executionAttempts[0]!, status: "failed", resources: collection({ usageEvents: [usage("failed", { metrics: { totalTokens: 10 } })] }) },
      { ...subject.executionAttempts[0]!, executionAttemptId: "restart-1", attemptNumber: 2, status: "completed", resources: collection({ usageEvents: [usage("completed", { metrics: { totalTokens: 20 } })] }) },
    ] }], evaluations: [{ ...judge, status: { status: "failed" }, attempts: [
      { ...judge.attempts[0]!, status: "interrupted", resources: collection({ usageEvents: [usage("interrupted", { metrics: { totalTokens: 40 } })] }) },
      { ...judge.attempts[0]!, evaluationAttemptId: "restart-2", attemptNumber: 2, status: "cancelled", resources: collection({ usageEvents: [usage("cancelled", { metrics: { totalTokens: 80 } })] }) },
    ] }] });
    expect(result.execution).toMatchObject({ attempts: 2, restarts: 1, failedAttempts: 1, completedAttempts: 1 });
    expect(result.evaluation).toMatchObject({ attempts: 2, restarts: 1, interruptedAttempts: 1, cancelledAttempts: 1 });
    expect(result.resources.execution.tokens.total.value).toBe(30);
    expect(result.resources.evaluation.tokens.total.value).toBe(120);
    expect(result.resources.total.tokens.total.value).toBe(150);
  });

  it("measures agent spans including restart gaps rather than claiming parallel run wall-clock duration", () => {
    const subject = sampling();
    const attempts = [
      { ...subject.executionAttempts[0]!, status: "failed" as const },
      { ...subject.executionAttempts[0]!, executionAttemptId: "restart", attemptNumber: 2, startedAt: "2026-10-08T00:00:03.000Z", completedAt: "2026-10-08T00:00:05.000Z" },
    ];
    const result = aggregateMetrics({ samplings: [{ ...subject, executionAttempts: attempts }, sampling("sampling-2")], evaluations: [] });
    expect(result.execution.agentDurationMs).toEqual({ count: 2, missing: 0, total: 6_000, min: 1_000, max: 5_000, mean: 3_000, median: 3_000 });
    expect(result).not.toHaveProperty("runDurationMs");
  });

  it.each([
    { startedAt: "not-a-date" },
    { completedAt: "not-a-date" },
    { completedAt: "2026-10-07T23:59:59.000Z" },
  ])("keeps invalid or reversed attempt timestamps out of duration statistics: %j", (patch) => {
    const subject = sampling();
    const result = aggregateMetrics({ samplings: [{ ...subject, executionAttempts: [{ ...subject.executionAttempts[0]!, ...patch }] }], evaluations: [] });
    expect(result.execution.agentDurationMs).toMatchObject({ count: 0, missing: 1, total: null });
  });

  it("groups scores by full evaluator identity and retains every re-evaluation", () => {
    const base = evaluation();
    const { score: omitted, ...withoutScore } = base.output!;
    expect(omitted).toBe(80);
    const result = aggregateMetrics({ samplings: [sampling()], evaluations: [
      base,
      evaluation("evaluation-2", { output: { ...base.output!, score: 100 } }),
      evaluation("evaluation-3", { output: withoutScore }),
      evaluation("evaluation-4", { output: { ...base.output!, score: NaN } }),
      evaluation("evaluation-5", { evaluator: { ...base.evaluator, userAgentId: "other-judge" }, output: { ...base.output!, score: 1 } }),
      evaluation("evaluation-6", { evaluator: { ...base.evaluator, ownerUserId: "other-owner" }, output: { ...base.output!, score: -10 } }),
    ] });
    expect(result.samplingCount).toBe(1);
    expect(result.evaluationCount).toBe(6);
    expect(result.scores).toHaveLength(3);
    expect(result.scores.find((item) => item.evaluator.ownerUserId === base.evaluator.ownerUserId && item.evaluator.userAgentId === base.evaluator.userAgentId))
      .toMatchObject({ evaluations: 4, unavailable: 1, invalid: 1, scores: { count: 2, missing: 2, mean: 90, median: 90 } });
    expect(result).not.toHaveProperty("averageScore");
  });

  it("deduplicates total raw resource facts instead of adding execution/evaluation subtotals", () => {
    const subject = sampling();
    const judge = evaluation();
    const resources = collection({ usageEvents: [usage("shared-source-fact")] });
    const result = aggregateMetrics({
      samplings: [{ ...subject, executionAttempts: [{ ...subject.executionAttempts[0]!, resources }] }],
      evaluations: [{ ...judge, attempts: [{ ...judge.attempts[0]!, resources }] }],
    });
    expect(result.resources.execution.tokens.total.value).toBe(35);
    expect(result.resources.evaluation.tokens.total.value).toBe(35);
    expect(result.resources.total.tokens.total.value).toBe(35);
    expect(result.resources.total.duplicateRecords.usageEvents).toBe(1);
  });

  it("rejects duplicate and orphan identities before counting", () => {
    expect(() => aggregateMetrics({ samplings: [sampling(), sampling()], evaluations: [] })).toThrow("Duplicate Sampling");
    expect(() => aggregateMetrics({ samplings: [sampling()], evaluations: [evaluation(), evaluation()] })).toThrow("Duplicate Evaluation");
    expect(() => aggregateMetrics({ samplings: [], evaluations: [evaluation()] })).toThrow("Sampling scope");
  });

  it("does not mutate input or expose a judge identity shared with source records", () => {
    const input = { samplings: [sampling()], evaluations: [evaluation()] };
    const before = structuredClone(input);
    const result = aggregateMetrics(input);
    Object.assign(result.scores[0]!.evaluator, { userAgentId: "modified" });
    expect(input).toEqual(before);
  });
});
