import { describe, expect, it } from "vitest";
import { evaluation } from "../test-support.js";
import { readEvaluationMetrics } from "./index.js";

describe("evaluation output interpretation", () => {
  it.each([0, -5, 0.75, 95, 1_000])("preserves score %s without assuming a scale", (score) => {
    const record = evaluation();
    expect(readEvaluationMetrics({ ...record, output: { ...record.output!, score } }).score)
      .toEqual({ status: "available", value: score });
  });

  it("keeps an unreported score separate from zero", () => {
    const record = evaluation();
    const { score: omitted, ...output } = record.output!;
    expect(omitted).toBe(80);
    expect(readEvaluationMetrics({ ...record, output }).score).toEqual({ status: "unavailable", value: null });
    const { output: absent, ...pending } = record;
    expect(absent).toBeDefined();
    expect(readEvaluationMetrics({ ...pending, status: { status: "queued" } })).toMatchObject({
      score: { status: "unavailable", value: null }, outputStatus: null, trajectory: null, artifacts: [], evidenceRefs: [],
    });
  });

  it.each([NaN, Infinity, -Infinity])("reports invalid score %s without turning it into zero", (score) => {
    const record = evaluation();
    expect(readEvaluationMetrics({ ...record, output: { ...record.output!, score } }).score)
      .toEqual({ status: "invalid", value: null });
  });

  it("separates runtime finalization failure from a successful agent output", () => {
    const result = readEvaluationMetrics(evaluation("evaluation-1", {
      status: { status: "failed", lastError: "Database unavailable during finalization" },
    }));
    expect(result.stage).toEqual({ status: "failed", lastError: "Database unavailable during finalization" });
    expect(result.outputStatus).toBe("succeeded");
    expect(result.score).toEqual({ status: "available", value: 80 });
    expect(result.reason).toContain("produced page");
    expect(result.evidenceRefs).toEqual([{ kind: "artifact", ref: "/workspace/page.html" }]);
  });

  it("preserves failed agent output and its evidence without inventing a passing threshold", () => {
    const record = evaluation();
    const result = readEvaluationMetrics({ ...record, output: { ...record.output!, status: "failed", error: "Test failed", score: 0 } });
    expect(result).toMatchObject({ outputStatus: "failed", outputError: "Test failed", score: { status: "available", value: 0 } });
    expect(result).not.toHaveProperty("passed");
  });

  it("detaches all nested output fields from the original record", () => {
    const record = evaluation();
    const before = structuredClone(record);
    const result = readEvaluationMetrics(record);
    expect(result.evaluator).not.toBe(record.evaluator);
    expect(result.stage).not.toBe(record.status);
    expect(result.artifacts[0]).not.toBe(record.output!.artifacts[0]);
    expect(result.trajectory).not.toBe(record.output!.trajectory);
    Object.assign(result.evidenceRefs[0]!, { ref: "/changed" });
    Object.assign(result.evaluator, { userAgentId: "changed" });
    expect(record).toEqual(before);
  });
});
