import { describe, expect, it } from "vitest";
import type { EvaluationOutputSchema, EvaluationRecord } from "@eval-platform/eval-contracts";
import { createEvaluationOutputReader } from "../evaluators/index.js";
import { evaluation, OUTPUT_SCHEMA, SCHEMA_REF } from "../test-support.js";
import type { OutputFieldSummary } from "./model.js";
import { summarizeOutputFields } from "./output-fields.js";

describe("evaluation output field summaries", () => {
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
    const summary = summarizeOutputFields(reader, records);
    expect(summary).toMatchObject({ schema: SCHEMA_REF, coverage: "partial", evaluations: 5, validation: { valid: 3, invalid: 1, unavailable: 1 } });
    const [score, value] = summary.fields;
    expect(score).toMatchObject({
      jsonPointer: "/score", kinds: ["number"], observationCount: 2, contributingEvaluationCount: 2, missingEvaluationCount: 3,
      numeric: { count: 2, total: 30, mean: 15, median: 15 }, distribution: [], coverage: "partial",
      diagnostics: [{ reason: "invalid-output", evaluations: 1 }, { reason: "not-succeeded", evaluations: 2 }],
    });
    expect(value).toMatchObject({
      jsonPointer: "/scores/*/value", kinds: ["integer"], observationCount: 3, contributingEvaluationCount: 1, missingEvaluationCount: 4,
      numeric: { total: 6, min: 1, max: 3, mean: 2 },
      diagnostics: [{ reason: "absent", evaluations: 1 }, { reason: "invalid-output", evaluations: 1 }, { reason: "not-succeeded", evaluations: 2 }],
    });
  });

  it("is unavailable without an evaluation plan and lists declared fields before any result exists", () => {
    expect(summarizeOutputFields(createEvaluationOutputReader(null, null), [evaluation()]))
      .toMatchObject({ schema: null, coverage: "unavailable", fields: [], validation: { unavailable: 1 } });
    const empty = summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, OUTPUT_SCHEMA), []);
    expect(empty.fields.map((field) => [field.jsonPointer, field.coverage, field.numeric?.total])).toEqual([
      ["/score", "unavailable", null], ["/scores/*/value", "unavailable", null],
    ]);
  });

  const SCHEMA: EvaluationOutputSchema = {
    $defs: { verdict: { oneOf: [{ const: "pass" }, { const: "fail" }, { const: null }] } },
    type: "object",
    properties: {
      passed: { type: ["boolean", "null"] },
      verdict: { $ref: "#/$defs/verdict" },
      rating: { type: ["integer", "null"], enum: [1, 2, 3, null] },
      score: { type: ["number", "null"] },
      tags: { type: "array", items: { enum: ["a", "b", "c", null] } },
      either: { type: ["number", "boolean"] },
      checks: { type: "array", items: { type: "object", properties: { passed: { type: "boolean" } } } },
      comment: { type: ["string", "null"] },
    },
  };
  const fieldsOf = (records: readonly EvaluationRecord[]) => Object.fromEntries(
    summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, SCHEMA), records).fields.map((field) => [field.jsonPointer, field]),
  );
  const entries = (field: OutputFieldSummary) => field.distribution.map(({ value, count, share, evaluations }) => [value, count, share, evaluations]);
  const shareTotal = (field: OutputFieldSummary) =>
    field.distribution.reduce((total, entry) => total + entry.share!, field.nullCount! / field.observationCount);

  it("counts allowed nulls apart from boolean and enum entries whose shares include nulls in the denominator", () => {
    const fields = fieldsOf([
      evaluation("e1", {}, { passed: true, verdict: "pass", rating: 3, score: 1, comment: "free" }),
      evaluation("e2", {}, { passed: false, verdict: null, rating: null, score: null, comment: null }),
      evaluation("e3", {}, { passed: null, verdict: "pass", rating: 1, score: 3 }),
      evaluation("e4", {}, { passed: true }),
      evaluation("e5", {}, { passed: "yes" }),
    ]);
    expect(Object.keys(fields)).toEqual(["/passed", "/verdict", "/rating", "/score", "/tags/*", "/either", "/checks/*/passed"]);
    expect(fields["/passed"]).toMatchObject({
      kinds: ["boolean"], numeric: null, observationCount: 4, contributingEvaluationCount: 4, missingEvaluationCount: 1,
      nullCount: 1, diagnostics: [{ reason: "invalid-output", evaluations: 1 }],
    });
    expect(entries(fields["/passed"]!)).toEqual([[true, 2, 0.5, 2], [false, 1, 0.25, 1]]);
    expect(fields["/verdict"]).toMatchObject({ kinds: ["enum"], nullCount: 1 });
    expect(entries(fields["/verdict"]!)).toEqual([["pass", 2, 2 / 3, 2], ["fail", 0, 0, 0]]);
    expect(fields["/rating"]).toMatchObject({ kinds: ["integer", "enum"], nullCount: 1, numeric: { count: 2, missing: 0, total: 4, mean: 2 } });
    expect(entries(fields["/rating"]!)).toEqual([[1, 1, 1 / 3, 1], [2, 0, 0, 0], [3, 1, 1 / 3, 1]]);
    expect(fields["/score"]).toMatchObject({
      kinds: ["number"], observationCount: 3, nullCount: 1, distribution: [], numeric: { count: 2, total: 4, min: 1, max: 3 },
    });
    for (const pointer of ["/passed", "/verdict", "/rating"]) expect(shareTotal(fields[pointer]!)).toBeCloseTo(1);
  });

  it("omits nullCount when the Schema does not allow null", () => {
    const fields = fieldsOf([evaluation("e1", {}, { either: 1, checks: [{ passed: true }] })]);
    expect(fields["/either"]).not.toHaveProperty("nullCount");
    expect(fields["/checks/*/passed"]).not.toHaveProperty("nullCount");
  });

  it("counts enum array occurrences and the evaluations containing each value, null elements included", () => {
    const fields = fieldsOf([
      evaluation("e1", {}, { tags: ["a", "a", null] }),
      evaluation("e2", {}, { tags: ["a", "b"] }),
      evaluation("e3", {}, { tags: [] }),
    ]);
    expect(fields["/tags/*"]).toMatchObject({
      kinds: ["enum"], numeric: null, observationCount: 5, nullCount: 1, contributingEvaluationCount: 2, missingEvaluationCount: 1,
    });
    expect(entries(fields["/tags/*"]!)).toEqual([["a", 3, 0.6, 2], ["b", 1, 0.2, 1], ["c", 0, 0, 0]]);
    expect(shareTotal(fields["/tags/*"]!)).toBeCloseTo(1);
  });

  it("feeds each value of a multi-type field into its own kind and aggregates nested array booleans", () => {
    const fields = fieldsOf([
      evaluation("e1", {}, { either: 4, checks: [{ passed: true }, { passed: false }] }),
      evaluation("e2", {}, { either: true, checks: [{ passed: true }] }),
      evaluation("e3", {}, { either: 2 }),
    ]);
    expect(fields["/either"]).toMatchObject({ kinds: ["number", "boolean"], observationCount: 3, numeric: { count: 2, total: 6 } });
    expect(entries(fields["/either"]!)).toEqual([[true, 1, 1 / 3, 1], [false, 0, 0, 0]]);
    expect(entries(fields["/checks/*/passed"]!)).toEqual([[true, 2, 2 / 3, 2], [false, 1, 1 / 3, 1]]);
    expect(fields["/checks/*/passed"]).toMatchObject({ contributingEvaluationCount: 2, diagnostics: [{ reason: "absent", evaluations: 1 }] });
  });

  it("lists declared entries with zero counts and null shares before any result exists", () => {
    const fields = fieldsOf([]);
    expect(entries(fields["/passed"]!)).toEqual([[true, 0, null, 0], [false, 0, null, 0]]);
    expect(fields["/passed"]!.nullCount).toBe(0);
    expect(fields["/passed"]!.coverage).toBe("unavailable");
  });

  it("aggregates map-valued fields by the Schema they reach, in first-seen order", () => {
    const schema: EvaluationOutputSchema = { type: "object", additionalProperties: { enum: ["yes", "no", null] } };
    const summary = summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, schema), [
      evaluation("e1", {}, { b: "yes", a: null }), evaluation("e2", {}, { b: "no" }),
    ]);
    expect(summary.fields.map((field) => [field.jsonPointer, field.kinds, entries(field), field.nullCount])).toEqual([
      ["/b", ["enum"], [["yes", 1, 0.5, 1], ["no", 1, 0.5, 1]], 0],
      ["/a", ["enum"], [["yes", 0, 0, 0], ["no", 0, 0, 0]], 1],
    ]);
  });

  it("unites a declared field with the alternative Schemas its values reach", () => {
    const schema: EvaluationOutputSchema = { anyOf: [{ properties: { a: { type: "number" } } }, { additionalProperties: { type: ["boolean", "null"] } }] };
    const [field] = summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, schema), [
      evaluation("e1", {}, { a: null }), evaluation("e2", {}, { a: true }), evaluation("e3", {}, { a: false }),
    ]).fields;
    expect(field).toMatchObject({ jsonPointer: "/a", kinds: ["number", "boolean"], observationCount: 3, nullCount: 1, numeric: { count: 0 } });
    expect(entries(field!)).toEqual([[true, 1, 1 / 3, 1], [false, 1, 1 / 3, 1]]);
    expect(shareTotal(field!)).toBeCloseTo(1);
  });

  it("counts integers of a mixed integer/boolean field in the share denominator", () => {
    const schema: EvaluationOutputSchema = { type: "object", properties: { mixed: { type: ["integer", "boolean"] } } };
    const [field] = summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, schema), [
      evaluation("e1", {}, { mixed: 3 }), evaluation("e2", {}, { mixed: true }), evaluation("e3", {}, { mixed: false }), evaluation("e4", {}, { mixed: 5 }),
    ]).fields;
    expect(field).toMatchObject({ kinds: ["integer", "boolean"], observationCount: 4, numeric: { count: 2, total: 8 } });
    expect(field).not.toHaveProperty("nullCount");
    expect(entries(field!)).toEqual([[true, 1, 0.25, 1], [false, 1, 0.25, 1]]);
  });
});
