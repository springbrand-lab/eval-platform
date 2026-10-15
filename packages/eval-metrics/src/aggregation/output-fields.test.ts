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

  it("derives presentation metadata from the Schema before any observations exist", () => {
    const reader = createEvaluationOutputReader(SCHEMA_REF, {
      $defs: { grade: { title: "Default grade", description: "Default explanation", type: "number" } },
      type: "object", properties: {
        score: { title: "Quality", description: "Overall quality score", $ref: "#/$defs/grade" },
        passed: { type: "boolean" },
      },
    });
    const summary = summarizeOutputFields(reader, []);
    expect(summary.fields.map(({ jsonPointer, title, description, kinds }) => ({ jsonPointer, title, description, kinds }))).toEqual([
      { jsonPointer: "/score", title: "Quality", description: "Overall quality score", kinds: ["number"] },
      { jsonPointer: "/passed", title: "/passed", description: null, kinds: ["boolean"] },
    ]);
  });

  it.each([
    { values: [{}, {}], observations: 0, missing: 2, coverage: "unavailable" },
    { values: [{ score: 1 }, {}], observations: 1, missing: 1, coverage: "partial" },
    { values: [{ score: 1 }, { score: 2 }], observations: 2, missing: 0, coverage: "complete" },
    { values: [{ score: null }, { score: null }], observations: 2, missing: 0, coverage: "complete" },
  ])("computes field coverage from contributing observations: %j", ({ values, observations, missing, coverage }) => {
    const reader = createEvaluationOutputReader(SCHEMA_REF, { type: "object", properties: { score: { type: ["number", "null"] } } });
    const summary = summarizeOutputFields(reader, values.map((value, index) => evaluation(`e${index}`, {}, value)));
    expect(summary.coverage).toBe("complete");
    expect(summary.fields[0]).toMatchObject({ observationCount: observations, missingEvaluationCount: missing, coverage });
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

  it.each([
    { additionalProperties: { oneOf: [{ const: "a" }, { const: "b" }, { const: null }] } },
    { patternProperties: { "^check$": { oneOf: [{ const: "a" }, { const: "b" }, { const: null }] } } },
  ] satisfies EvaluationOutputSchema[])("retains unobserved options and nullability for dynamically named fields: %j", (schema) => {
    const [field] = summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, { type: "object", ...schema }), [
      evaluation("e1", {}, { check: "a" }),
    ]).fields;
    expect(field).toMatchObject({ jsonPointer: "/check", kinds: ["enum"], observationCount: 1, nullCount: 0 });
    expect(entries(field!)).toEqual([["a", 1, 1, 1], ["b", 0, 0, 0]]);
  });

  it("retains reference-alias presentation metadata on dynamically named fields", () => {
    const schema: EvaluationOutputSchema = {
      type: "object", additionalProperties: { $ref: "#/x/alias" },
      x: {
        alias: { $ref: "#/x/value", title: "Alias title", description: "Alias description" },
        value: { type: "number", title: "Target title", description: "Target description" },
      },
    };
    const [field] = summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, schema), [evaluation("e", {}, { s: 3 })]).fields;
    expect(field).toMatchObject({ jsonPointer: "/s", title: "Alias title", description: "Alias description", kinds: ["number"], numeric: { count: 1, total: 3 } });
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

  it.each([
    { const: "a", enum: ["a", "b", null] },
    { type: ["string", "null"], const: "a", enum: ["a", "b", null] },
    { allOf: [{ const: "a" }, { enum: ["a", "b", null] }] },
  ])("keeps only values satisfying every const/enum constraint: %j", (verdict) => {
    const schema: EvaluationOutputSchema = { type: "object", properties: { verdict } };
    const summary = summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, schema), [evaluation("e1", {}, { verdict: "a" })]);
    const [field] = summary.fields;
    expect(entries(field!)).toEqual([["a", 1, 1, 1]]);
    expect(field).not.toHaveProperty("nullCount");
  });

  it("uses full Schema validation for finite values even when a constraint declares no type", () => {
    const schema: EvaluationOutputSchema = {
      type: "object",
      allOf: [
        { properties: { rating: { enum: [1, 2, 3] }, passed: { type: ["boolean", "null"] } } },
        { properties: { rating: { minimum: 2 }, passed: { not: { type: "null" } } } },
      ],
    };
    const summary = summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, schema), [evaluation("e1", {}, { rating: 2, passed: true })]);
    const [rating, passed] = summary.fields;
    expect(entries(rating!)).toEqual([[2, 1, 1, 1], [3, 0, 0, 0]]);
    expect(passed).not.toHaveProperty("nullCount");
  });

  it.each([
    { branch: { type: "boolean", not: { const: false } }, excluded: false, included: true },
    { branch: { enum: [1, 2], minimum: 2 }, excluded: 1, included: 2 },
    { branch: { allOf: [{ enum: [1, 2] }, { minimum: 2 }] }, excluded: 1, included: 2 },
    { branch: { $ref: "#/$defs/choice" }, excluded: 1, included: 2 },
    { branch: { enum: ["ok", null], not: { type: "null" } }, excluded: null, included: "ok" },
  ])("confirms each branch's finite candidates before a permissive alternative can admit them: %j", ({ branch, excluded, included }) => {
    const reader = createEvaluationOutputReader(SCHEMA_REF, {
      $defs: { choice: { enum: [1, 2], minimum: 2 } }, type: "object", properties: { value: { anyOf: [branch, {}] } },
    });
    const skipped = evaluation("e1", {}, { value: excluded });
    const counted = evaluation("e2", {}, { value: included });
    expect(reader.read(skipped).view).toMatchObject({ validation: { status: "valid" }, observations: [] });
    expect(summarizeOutputFields(reader, []).fields[0]!.distribution.map((entry) => entry.value)).toEqual([included]);
    const [field] = summarizeOutputFields(reader, [skipped, counted]).fields;
    expect(field).toMatchObject({
      jsonPointer: "/value", observationCount: 1, contributingEvaluationCount: 1, missingEvaluationCount: 1,
      diagnostics: [{ reason: "absent", evaluations: 1 }],
    });
    expect(field).not.toHaveProperty("nullCount");
    expect(entries(field!)).toEqual([[included, 1, 1, 1]]);
  });

  it.each([
    { const: 1, not: { const: 1 } },
    { allOf: [{ const: 1 }, { minimum: 2 }] },
  ])("never manufactures a field from an impossible declaring branch: %j", (branch) => {
    const reader = createEvaluationOutputReader(SCHEMA_REF, { anyOf: [branch, {}] });
    const record = evaluation("e1", {}, 1);
    expect(reader.read(record).view).toMatchObject({ validation: { status: "valid" }, observations: [] });
    expect(summarizeOutputFields(reader, []).fields).toEqual([]);
    expect(summarizeOutputFields(reader, [record]).fields).toEqual([]);
  });

  it.each([
    { oneOf: [{ type: "boolean", not: { const: false } }, { not: { const: true } }] },
    { if: { const: true }, then: { type: "boolean", not: { const: false } } },
    { if: { const: false }, else: { type: "boolean", not: { const: false } } },
  ])("uses the same declaration admission for oneOf and conditional alternatives: %j", (schema) => {
    const reader = createEvaluationOutputReader(SCHEMA_REF, schema);
    const skipped = evaluation("e1", {}, false);
    const counted = evaluation("e2", {}, true);
    expect(reader.read(skipped).view).toMatchObject({ validation: { status: "valid" }, observations: [] });
    const summary = summarizeOutputFields(reader, [skipped, counted]);
    expect(summary.validation).toEqual({ valid: 2, invalid: 0, unavailable: 0 });
    expect(summary.fields[0]).toMatchObject({ observationCount: 1, missingEvaluationCount: 1 });
    expect(entries(summary.fields[0]!)).toEqual([[true, 1, 1, 1]]);
  });

  it.each([
    { type: "integer", excluded: 1, included: 2 },
    { type: "number", excluded: 1.5, included: 2.5 },
  ])("requires an observed number to match its declaring branch: %j", ({ type, excluded, included }) => {
    const branch = { type, minimum: 2 };
    const reader = createEvaluationOutputReader(SCHEMA_REF, { anyOf: [branch, {}] });
    const skipped = evaluation("e1", {}, excluded);
    const counted = evaluation("e2", {}, included);
    expect(reader.read(skipped).view).toMatchObject({ validation: { status: "valid" }, observations: [] });
    expect(summarizeOutputFields(reader, [skipped, counted]).fields[0]).toMatchObject({
      observationCount: 1, contributingEvaluationCount: 1, missingEvaluationCount: 1,
      numeric: { count: 1, total: included }, distribution: [], diagnostics: [{ reason: "absent", evaluations: 1 }],
    });
    const outer = createEvaluationOutputReader(SCHEMA_REF, { type, anyOf: [branch, {}] });
    expect(summarizeOutputFields(outer, [skipped, counted]).fields[0]).toMatchObject({
      observationCount: 2, numeric: { count: 2, total: excluded + included }, diagnostics: [],
    });
  });

  it.each([false, true])("confirms each tuple position before merging it with an unconstrained tail, nested=%s", (nested) => {
    const tuple = { type: "array", allOf: [
      { prefixItems: [{ enum: [1, 2] }] }, { prefixItems: [{ minimum: 2 }] },
    ] };
    const reader = createEvaluationOutputReader(SCHEMA_REF, nested ? { type: "array", items: tuple } : tuple);
    const record = evaluation("e1", {}, nested ? [[2, 1]] : [2, 1]);
    expect(reader.read(record).view).toMatchObject({ validation: { status: "valid" } });
    expect(summarizeOutputFields(reader, []).fields[0]!.distribution.map((entry) => entry.value)).toEqual([2]);
    const [field] = summarizeOutputFields(reader, [record]).fields;
    expect(field).toMatchObject({ jsonPointer: nested ? "/*/*" : "/*", observationCount: 1, numeric: { count: 1, total: 2 } });
    expect(entries(field!)).toEqual([[2, 1, 1, 1]]);
  });

  it("counts null-only tuple positions in the complete field shape", () => {
    const schema: EvaluationOutputSchema = { type: "array", prefixItems: [{ type: "boolean" }, { type: "null" }] };
    const [field] = summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, schema), [evaluation("e1", {}, [true, null])]).fields;
    expect(field).toMatchObject({ jsonPointer: "/*", observationCount: 2, contributingEvaluationCount: 1, missingEvaluationCount: 0, nullCount: 1 });
    expect(entries(field!)).toEqual([[true, 1, 0.5, 1], [false, 0, 0, 0]]);
  });

  it("retains dynamic null candidates until the queried scope determines field eligibility", () => {
    const schema: EvaluationOutputSchema = { type: "object", oneOf: [
      { properties: { mode: { const: "measured" } }, required: ["mode"], additionalProperties: { type: "boolean" } },
      { properties: { mode: { const: "skipped" } }, required: ["mode"], additionalProperties: { type: "null" } },
    ] };
    const reader = createEvaluationOutputReader(SCHEMA_REF, schema);
    const skipped = evaluation("e1", {}, { mode: "skipped", check: null });
    const measured = evaluation("e2", {}, { mode: "measured", check: true });
    const [mode, check] = summarizeOutputFields(reader, [skipped, measured]).fields;
    expect(mode?.jsonPointer).toBe("/mode");
    expect(check).toMatchObject({
      jsonPointer: "/check", observationCount: 2, contributingEvaluationCount: 2, missingEvaluationCount: 0,
      nullCount: 1, diagnostics: [],
    });
    expect(entries(check!)).toEqual([[true, 1, 0.5, 1], [false, 0, 0, 0]]);
    expect(summarizeOutputFields(reader, [skipped]).fields.map((field) => field.jsonPointer)).toEqual(["/mode"]);
  });

  it.each([false, true])("preserves tuple coordinates through allOf before collapsing nested=%s paths", (nested) => {
    const item = (values: readonly string[]) => nested ? { type: "array", items: { enum: values } } : { enum: values };
    const schema: EvaluationOutputSchema = { type: "array", maxItems: 2, allOf: [
      { prefixItems: [item(["a", "z"]), item(["b"])] },
      { prefixItems: [item(["a"]), item(["b", "z"])] },
    ] };
    const reader = createEvaluationOutputReader(SCHEMA_REF, schema);
    const empty = summarizeOutputFields(reader, []).fields;
    expect(empty.map((field) => [field.jsonPointer, field.distribution.map((entry) => entry.value)])).toEqual([
      [nested ? "/*/*" : "/*", ["a", "b"]],
    ]);
    const [field] = summarizeOutputFields(reader, [evaluation("e1", {}, nested ? [["a"], ["b"]] : ["a", "b"])]).fields;
    expect(entries(field!)).toEqual([["a", 1, 0.5, 1], ["b", 1, 0.5, 1]]);
  });

  it("distinguishes unconstrained tuple tails from forbidden positions", () => {
    const schema = (items: boolean, maxItems?: number): EvaluationOutputSchema => ({
      type: "array", ...maxItems === undefined ? {} : { maxItems },
      allOf: [{ prefixItems: [{ const: "a" }], items }, { items: { enum: ["a", "z"] } }],
    });
    const values = (format: EvaluationOutputSchema) => summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, format), [])
      .fields[0]!.distribution.map((entry) => entry.value);
    expect(values(schema(true))).toEqual(["a", "z"]);
    expect(values(schema(false))).toEqual(["a"]);
    expect(values(schema(true, 1))).toEqual(["a"]);
  });

  it("does not aggregate impossible fields or fields whose complete shape only allows null or free text", () => {
    const schema: EvaluationOutputSchema = {
      type: "object", properties: { impossible: false, empty: { const: null }, note: { type: ["string", "null"] } },
      allOf: [{ properties: { impossible: { type: "boolean" } } }],
    };
    expect(summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, schema), [evaluation("e1", {}, { empty: null, note: null })]).fields).toEqual([]);
  });

  it.each([
    { anyOf: [true, false] },
    { anyOf: [false, true] },
    { anyOf: [{}, false] },
    { anyOf: [false, { description: "No additional declarations" }] },
    { anyOf: [{ const: true }, true] },
    { oneOf: [true, false] },
    { oneOf: [false, {}] },
    { allOf: [true, { anyOf: [false, true] }] },
    { $ref: "#/$defs/unrestricted" },
  ])("keeps outer boolean/null declarations through unconstrained alternatives: %j", (alternatives) => {
    const schema: EvaluationOutputSchema = {
      $defs: { unrestricted: { anyOf: [true, false] } },
      type: "object", properties: { flag: { type: ["boolean", "null"], ...alternatives } },
    };
    const reader = createEvaluationOutputReader(SCHEMA_REF, schema);
    const records = [evaluation("e1", {}, { flag: true }), evaluation("e2", {}, { flag: false }), evaluation("e3", {}, { flag: null })];
    const summary = summarizeOutputFields(reader, records);
    expect(summary.validation).toEqual({ valid: 3, invalid: 0, unavailable: 0 });
    const [field] = summary.fields;
    expect(field).toMatchObject({
      jsonPointer: "/flag", kinds: ["boolean"], observationCount: 3, contributingEvaluationCount: 3,
      missingEvaluationCount: 0, nullCount: 1, diagnostics: [],
    });
    expect(entries(field!)).toEqual([[true, 1, 1 / 3, 1], [false, 1, 1 / 3, 1]]);
    expect(records.map((record) => reader.read(record).view.observations.map((observation) => observation.value))).toEqual([[true], [false], [null]]);
  });

  it.each([
    { if: { type: "integer" }, then: { enum: [0, 1] } },
    { if: { type: "null" }, else: { enum: [0, 1] } },
  ])("retains null when a scalar conditional has an implicit unconstrained branch: %j", (conditional) => {
    const schema: EvaluationOutputSchema = { type: "object", properties: { rating: { type: ["integer", "null"], ...conditional } } };
    const summary = summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, schema), [
      evaluation("e1", {}, { rating: 1 }), evaluation("e2", {}, { rating: null }), evaluation("e3", {}, { rating: 2 }),
    ]);
    expect(summary.validation).toEqual({ valid: 2, invalid: 1, unavailable: 0 });
    const [field] = summary.fields;
    expect(field).toMatchObject({
      kinds: ["integer", "enum"], observationCount: 2, contributingEvaluationCount: 2, missingEvaluationCount: 1,
      nullCount: 1, numeric: { count: 1, total: 1 }, diagnostics: [{ reason: "invalid-output", evaluations: 1 }],
    });
    expect(entries(field!)).toEqual([[0, 0, 0, 0], [1, 1, 0.5, 1]]);
  });

  it("retains original numeric observations through a conditional that forbids only its matched branch", () => {
    const schema: EvaluationOutputSchema = { type: "number", if: { minimum: 0 }, then: false };
    const [field] = summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, schema), [evaluation("e1", {}, -1)]).fields;
    expect(field).toMatchObject({ jsonPointer: "", kinds: ["number"], observationCount: 1, numeric: { count: 1, total: -1 } });
  });

  it("preserves a declared number family alongside a literal alternative and an untyped numeric constraint", () => {
    const schema: EvaluationOutputSchema = { type: "number", anyOf: [{ minimum: 0 }, { const: -1 }] };
    const [field] = summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, schema), [
      evaluation("e1", {}, 2.5), evaluation("e2", {}, -1),
    ]).fields;
    expect(field).toMatchObject({ kinds: ["number", "enum"], observationCount: 2, numeric: { count: 2, total: 1.5 } });
    expect(entries(field!)).toEqual([[-1, 1, 0.5, 1]]);
  });

  it.each([
    { anyOf: [true, false] },
    { anyOf: [{ allOf: [false, { type: "boolean" }] }, true] },
    { anyOf: [true, { allOf: [{ const: true }, false] }] },
  ])("does not manufacture declarations from unconstrained or impossible alternatives: %j", (schema) => {
    const reader = createEvaluationOutputReader(SCHEMA_REF, schema);
    const record = evaluation("e1", {}, false);
    expect(reader.read(record).view).toMatchObject({ validation: { status: "valid" }, observations: [] });
    expect(summarizeOutputFields(reader, [record]).fields).toEqual([]);
  });

  it("merges duplicate normalized declarations in Schema order before any observations exist", () => {
    const schema: EvaluationOutputSchema = {
      type: ["object", "array"], properties: { "*": { enum: ["a", null] } }, items: { enum: ["b"] },
    };
    const reader = createEvaluationOutputReader(SCHEMA_REF, schema);
    const [empty] = summarizeOutputFields(reader, []).fields;
    expect(empty).toMatchObject({ jsonPointer: "/*", kinds: ["enum"], nullCount: 0 });
    expect(entries(empty!)).toEqual([["a", 0, null, 0], ["b", 0, null, 0]]);
    const [field] = summarizeOutputFields(reader, [
      evaluation("e1", {}, { "*": "a" }), evaluation("e2", {}, ["b"]), evaluation("e3", {}, { "*": null }),
    ]).fields;
    expect(field).toMatchObject({ observationCount: 3, contributingEvaluationCount: 3, missingEvaluationCount: 0, nullCount: 1 });
    expect(entries(field!)).toEqual([["a", 1, 1 / 3, 1], ["b", 1, 1 / 3, 1]]);
  });

  it("preserves every kind when a literal wildcard key and array items share a field", () => {
    const schema: EvaluationOutputSchema = { type: ["object", "array"], properties: { "*": { type: "number" } }, items: { type: "boolean" } };
    const [field] = summarizeOutputFields(createEvaluationOutputReader(SCHEMA_REF, schema), [evaluation("e1", {}, [true])]).fields;
    expect(field).toMatchObject({ jsonPointer: "/*", kinds: ["number", "boolean"], numeric: { count: 0, total: null } });
  });

  it.each([
    { enum: [false, true] },
    { type: "boolean", enum: [false, true] },
    { enum: ["x", false, true, null] },
    { allOf: [true, { enum: [false, true, null] }] },
  ])("keeps declaration order through the unconstrained intersection identity: %j", (schema) => {
    const reader = createEvaluationOutputReader(SCHEMA_REF, schema);
    const expected = "enum" in schema ? schema.enum!.filter((value) => value !== null) : [false, true];
    expect(summarizeOutputFields(reader, []).fields[0]!.distribution.map((entry) => entry.value)).toEqual(expected);
    const [field] = summarizeOutputFields(reader, [evaluation("e1", {}, false)]).fields;
    expect(field!.distribution.map((entry) => entry.value)).toEqual(expected);
    expect(field!.distribution.find((entry) => entry.value === false)).toMatchObject({ count: 1, share: 1 });
  });

  it.each([
    { schema: { anyOf: [{ const: 1 }, true] }, literal: 1 },
    { schema: { anyOf: [{ minimum: 0 }, { const: -1 }] }, literal: -1 },
    { schema: { anyOf: [{ enum: [0.5, 1] }, {}] }, literal: 0.5 },
  ] satisfies { schema: EvaluationOutputSchema; literal: number }[])("counts only numeric values admitted by declarations: %j", ({ schema, literal }) => {
    const reader = createEvaluationOutputReader(SCHEMA_REF, schema);
    const undeclared = evaluation("e1", {}, 2.5);
    const declared = evaluation("e2", {}, literal);
    expect(reader.read(undeclared).view).toMatchObject({ validation: { status: "valid" }, observations: [] });
    const [field] = summarizeOutputFields(reader, [undeclared, declared]).fields;
    expect(field).toMatchObject({
      observationCount: 1, contributingEvaluationCount: 1, missingEvaluationCount: 1,
      numeric: { count: 1, total: literal }, diagnostics: [{ reason: "absent", evaluations: 1 }],
    });
  });
});
