import { describe, expect, it } from "vitest";
import type { EvaluationOutputSchema, EvaluationRecord, JsonValue } from "@eval-platform/eval-contracts";
import { evaluation, OUTPUT_SCHEMA, SCHEMA_REF } from "../test-support.js";
import { createEvaluationOutputReader, summarizeNumericOutputs } from "./index.js";

const read = (result: JsonValue | string, schema: EvaluationOutputSchema | null = OUTPUT_SCHEMA, patch: Partial<EvaluationRecord> = {}) =>
  createEvaluationOutputReader(schema && SCHEMA_REF, schema).read(evaluation("evaluation-1", patch, result));
const numbers = (view: ReturnType<typeof read>) => view.numericObservations.map(({ jsonPointer, instancePointer, schemaType, value }) => (
  [jsonPointer, instancePointer, schemaType, value]
));

describe("evaluation output validation", () => {
  it("parses, validates and extracts nested, array and $ref numbers with stable pointers", () => {
    const content = JSON.stringify({ score: 7.5, summary: "fine", scores: [{ name: "a", value: 3 }, { name: "b", value: 4 }] });
    const view = read(content);
    expect(view).toMatchObject({
      validation: { status: "valid", reason: "valid", errors: [] }, content,
      rawJson: { score: 7.5, summary: "fine" }, path: "/evaluations/evaluation-1/result.json",
      evidenceRefs: [{ kind: "artifact", ref: "/workspace/page.html" }], trajectory: { source: "evaluator" },
    });
    expect(numbers(view)).toEqual([
      ["/score", "/score", "number", 7.5], ["/scores/*/value", "/scores/0/value", "integer", 3], ["/scores/*/value", "/scores/1/value", "integer", 4],
    ]);
  });

  it("ignores string numbers, booleans and undeclared fields", () => {
    const view = read({ score: 1, extra: 5, scores: [{ value: 2, weight: 9 }], summary: "10" });
    expect(numbers(view).map(([pointer]) => pointer)).toEqual(["/score", "/scores/*/value"]);
    const strings = read({ score: "10" });
    expect(strings.validation).toMatchObject({ status: "invalid", reason: "schema-mismatch" });
    expect(strings.validation.errors[0]).toMatchObject({ instancePath: "/score", keyword: "type" });
    expect(strings.numericObservations).toEqual([]);
  });

  it("follows only the oneOf/anyOf branches that validate the value", () => {
    const schema: EvaluationOutputSchema = {
      type: "object",
      properties: {
        result: { oneOf: [
          { type: "object", properties: { kind: { const: "pass" }, points: { type: "integer" } }, required: ["kind"] },
          { type: "object", properties: { kind: { const: "fail" }, penalty: { type: "number" } }, required: ["kind"] },
        ] },
        metric: { anyOf: [{ type: "number" }, { type: "string" }] },
        mixed: { anyOf: [{ type: "integer" }, { type: "number", minimum: 0 }] },
      },
    };
    expect(numbers(read({ result: { kind: "fail", penalty: 2, points: 9 }, metric: 1.5, mixed: 3 }, schema))).toEqual([
      ["/result/penalty", "/result/penalty", "number", 2], ["/metric", "/metric", "number", 1.5], ["/mixed", "/mixed", "number", 3],
    ]);
    expect(numbers(read({ result: { kind: "pass", points: 9 }, metric: "x", mixed: -1 }, schema))).toEqual([
      ["/result/points", "/result/points", "integer", 9], ["/mixed", "/mixed", "integer", -1],
    ]);
  });

  it("handles allOf, prefixItems, additionalProperties and recursive $ref", () => {
    const schema: EvaluationOutputSchema = {
      $defs: { node: { type: "object", properties: { weight: { type: "number" }, children: { type: "array", items: { $ref: "#/$defs/node" } } } } },
      type: "object",
      allOf: [{ properties: { total: { type: "integer" } } }],
      properties: {
        tree: { $ref: "#/$defs/node" },
        pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
        byCriterion: { type: "object", additionalProperties: { type: "number" } },
      },
    };
    const view = read({ total: 3, tree: { weight: 1, children: [{ weight: 2, children: [] }] }, pair: ["x", 0.5], byCriterion: { "a/b": 4 } }, schema);
    expect(numbers(view)).toEqual([
      ["/total", "/total", "integer", 3], ["/tree/weight", "/tree/weight", "number", 1],
      ["/tree/children/*/weight", "/tree/children/0/weight", "number", 2], ["/pair/*", "/pair/1", "number", 0.5],
      ["/byCriterion/a~1b", "/byCriterion/a~1b", "number", 4],
    ]);
    const declared = [...createEvaluationOutputReader(SCHEMA_REF, schema).declaredFields.keys()];
    expect(declared).toEqual(["/total", "/tree/weight", "/pair/*"]);
  });

  it("reports a missing output or result file as unavailable", () => {
    const reader = createEvaluationOutputReader(SCHEMA_REF, OUTPUT_SCHEMA);
    const { output, ...pending } = evaluation();
    const { structuredOutput: _file, ...withoutFile } = output!;
    expect(reader.read(pending).validation).toEqual({ status: "unavailable", reason: "no-output", errors: [] });
    expect(reader.read({ ...pending, evaluationId: "e2", output: withoutFile })).toMatchObject({
      validation: { status: "unavailable", reason: "no-structured-output" }, content: null, rawJson: null, artifacts: output!.artifacts,
    });
  });

  it.each([
    ['{"score": 1,}', "invalid-json"],
    ['{"score": 1, "score": 2}', "invalid-json"],
    ["", "invalid-json"],
    ['{"score": 1e400}', "unsafe-number"],
    ['{"score": 9007199254740993}', "unsafe-number"],
  ])("rejects malformed or unrepresentable output %j without numbers", (content, reason) => {
    const view = read(content);
    expect(view).toMatchObject({ rawJson: null, numericObservations: [], validation: { status: "invalid", reason } });
    expect(view.validation.errors).toHaveLength(1);
  });

  it("keeps parsed JSON visible but unvalidated without a Schema or with an invalid one", () => {
    expect(read({ score: 1 }, null)).toMatchObject({ rawJson: { score: 1 }, validation: { status: "unavailable", reason: "no-schema" }, numericObservations: [] });
    expect(read({ score: 1 }, { type: "nope" })).toMatchObject({ validation: { status: "unavailable", reason: "invalid-schema" } });
  });

  it("extracts no numbers from a failed evaluation even when its output is valid", () => {
    const view = read({ score: 1 }, OUTPUT_SCHEMA, { status: { status: "failed", lastError: "boom" } });
    expect(view.validation.status).toBe("valid");
    expect(view.numericObservations).toEqual([]);
  });
});

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
