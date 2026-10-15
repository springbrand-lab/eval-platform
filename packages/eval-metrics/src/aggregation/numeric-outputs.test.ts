import { describe, expect, it } from "vitest";
import type { EvaluationRecord } from "@eval-platform/eval-contracts";
import { createEvaluationOutputReader } from "../evaluators/index.js";
import { evaluation, OUTPUT_SCHEMA, SCHEMA_REF } from "../test-support.js";
import { summarizeNumericOutputs } from "./numeric-outputs.js";

describe("numeric output summaries", () => {
  it("counts observations and contributing records separately and never fills gaps with zero", () => {
    const reader = createEvaluationOutputReader(SCHEMA_REF, OUTPUT_SCHEMA);
    const { output: _output, ...running } = evaluation("e5", { status: { status: "running" } });
    const pending: EvaluationRecord = running;
    const records = [
      evaluation("e1", {}, { score: 10, scores: [{ value: 1 }, { value: 2 }, { value: 3 }] }),
      evaluation("e2", {}, { score: 20 }),
      evaluation("e3", {}, { score: "30" }),
      evaluation("e4", { status: { status: "failed" } }, { score: 40 }),
      pending,
    ];
    const summary = summarizeNumericOutputs(reader, records);
    expect(summary).toMatchObject({ schema: SCHEMA_REF, coverage: "partial", evaluations: 5, validation: { valid: 3, invalid: 1, unavailable: 1 } });
    const [score, value] = summary.fields;
    expect(score).toMatchObject({
      jsonPointer: "/score", schemaType: "number", observationCount: 2, contributingEvaluationCount: 2, missingEvaluationCount: 3,
      summary: { count: 2, total: 30, mean: 15, median: 15 }, coverage: "partial",
      diagnostics: [{ reason: "invalid-output", evaluations: 1 }, { reason: "not-succeeded", evaluations: 2 }],
    });
    expect(value).toMatchObject({
      jsonPointer: "/scores/*/value", schemaType: "integer", observationCount: 3, contributingEvaluationCount: 1, missingEvaluationCount: 4,
      summary: { total: 6, min: 1, max: 3, mean: 2 },
      diagnostics: [{ reason: "absent", evaluations: 1 }, { reason: "invalid-output", evaluations: 1 }, { reason: "not-succeeded", evaluations: 2 }],
    });
  });

  it("is unavailable without an evaluation plan and lists declared fields before any result exists", () => {
    expect(summarizeNumericOutputs(createEvaluationOutputReader(null, null), [evaluation()]))
      .toMatchObject({ schema: null, coverage: "unavailable", fields: [], validation: { unavailable: 1 } });
    const empty = summarizeNumericOutputs(createEvaluationOutputReader(SCHEMA_REF, OUTPUT_SCHEMA), []);
    expect(empty.fields.map((field) => [field.jsonPointer, field.coverage, field.summary.total])).toEqual([
      ["/score", "unavailable", null], ["/scores/*/value", "unavailable", null],
    ]);
  });
});
