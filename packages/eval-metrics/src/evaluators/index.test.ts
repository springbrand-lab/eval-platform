import { describe, expect, it } from "vitest";
import type { EvaluationOutputSchema, EvaluationRecord, JsonValue } from "@eval-platform/eval-contracts";
import { evaluation, OUTPUT_SCHEMA, SCHEMA_REF } from "../test-support.js";
import { createEvaluationOutputReader } from "./index.js";

const read = (result: JsonValue | string, schema: EvaluationOutputSchema | null = OUTPUT_SCHEMA, patch: Partial<EvaluationRecord> = {}) =>
  createEvaluationOutputReader(schema && SCHEMA_REF, schema).read(evaluation("evaluation-1", patch, result));
const observed = (view: ReturnType<typeof read>) => view.observations.map(({ jsonPointer, instancePointer, kinds, value }) => (
  [jsonPointer, instancePointer, kinds.join("+"), value]
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
    expect(observed(view)).toEqual([
      ["/score", "/score", "number", 7.5], ["/scores/*/value", "/scores/0/value", "integer", 3], ["/scores/*/value", "/scores/1/value", "integer", 4],
    ]);
  });

  it("ignores string numbers, free text and undeclared fields", () => {
    const view = read({ score: 1, extra: 5, scores: [{ value: 2, weight: 9 }], summary: "10" });
    expect(observed(view).map(([pointer]) => pointer)).toEqual(["/score", "/scores/*/value"]);
    const strings = read({ score: "10" });
    expect(strings.validation).toMatchObject({ status: "invalid", reason: "schema-mismatch" });
    expect(strings.validation.errors[0]).toMatchObject({ instancePath: "/score", keyword: "type" });
    expect(strings.observations).toEqual([]);
  });

  it("follows only the oneOf/anyOf branches a container satisfies and reads branch consts as one enum", () => {
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
    expect(observed(read({ result: { kind: "fail", penalty: 2, points: 9 }, metric: 1.5, mixed: 3 }, schema))).toEqual([
      ["/result/kind", "/result/kind", "enum", "fail"], ["/result/penalty", "/result/penalty", "number", 2],
      ["/metric", "/metric", "number", 1.5], ["/mixed", "/mixed", "number", 3],
    ]);
    expect(observed(read({ result: { kind: "pass", points: 9 }, metric: "x", mixed: -1 }, schema))).toEqual([
      ["/result/kind", "/result/kind", "enum", "pass"], ["/result/points", "/result/points", "integer", 9], ["/mixed", "/mixed", "number", -1],
    ]);
    expect(createEvaluationOutputReader(SCHEMA_REF, schema).declaredFields.get("/result/kind")).toEqual({ kinds: ["enum"], values: ["pass", "fail"], nullable: false });
  });

  it("observes booleans, enums, enum arrays and allowed nulls with their kinds", () => {
    const schema: EvaluationOutputSchema = {
      $defs: { level: { enum: ["low", "high", null] } },
      type: "object",
      properties: {
        passed: { type: ["boolean", "null"] },
        rating: { type: "integer", enum: [1, 2, 3] },
        level: { $ref: "#/$defs/level" },
        tags: { type: "array", items: { enum: ["a", "b", null] } },
        either: { type: ["number", "boolean"] },
        checks: { type: "array", items: { type: "object", properties: { passed: { type: "boolean" }, note: { type: ["string", "null"] } } } },
        flag: { type: "boolean", const: true },
      },
    };
    const view = read({
      passed: null, rating: 2, level: null, tags: ["a", null], either: true,
      checks: [{ passed: false, note: null }, { passed: true, note: "ok" }], flag: true,
    }, schema);
    expect(observed(view)).toEqual([
      ["/passed", "/passed", "", null], ["/rating", "/rating", "integer+enum", 2], ["/level", "/level", "", null],
      ["/tags/*", "/tags/0", "enum", "a"], ["/tags/*", "/tags/1", "", null], ["/either", "/either", "boolean", true],
      ["/checks/*/passed", "/checks/0/passed", "boolean", false], ["/checks/*/passed", "/checks/1/passed", "boolean", true],
      ["/flag", "/flag", "boolean", true],
    ]);
    expect(Object.fromEntries(createEvaluationOutputReader(SCHEMA_REF, schema).declaredFields)).toEqual({
      "/passed": { kinds: ["boolean"], values: [true, false], nullable: true },
      "/rating": { kinds: ["integer", "enum"], values: [1, 2, 3], nullable: false },
      "/level": { kinds: ["enum"], values: ["low", "high"], nullable: true },
      "/tags/*": { kinds: ["enum"], values: ["a", "b"], nullable: true },
      "/either": { kinds: ["number", "boolean"], values: [true, false], nullable: false },
      "/checks/*/passed": { kinds: ["boolean"], values: [true, false], nullable: false },
      "/flag": { kinds: ["boolean"], values: [true], nullable: false },
    });
  });

  it("rejects a null the Schema does not allow, including one excluded by enum", () => {
    const schema: EvaluationOutputSchema = { type: "object", properties: { passed: { type: "boolean" }, level: { type: ["string", "null"], enum: ["low"] } } };
    expect(read({ passed: null }, schema)).toMatchObject({ validation: { status: "invalid", reason: "schema-mismatch" }, observations: [] });
    expect(read({ level: null }, schema).validation.status).toBe("invalid");
    expect(createEvaluationOutputReader(SCHEMA_REF, schema).declaredFields.get("/level")).toEqual({ kinds: ["enum"], values: ["low"], nullable: false });
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
    expect(observed(view)).toEqual([
      ["/total", "/total", "integer", 3], ["/tree/weight", "/tree/weight", "number", 1],
      ["/tree/children/*/weight", "/tree/children/0/weight", "number", 2], ["/pair/*", "/pair/1", "number", 0.5],
      ["/byCriterion/a~1b", "/byCriterion/a~1b", "number", 4],
    ]);
    const declared = [...createEvaluationOutputReader(SCHEMA_REF, schema).declaredFields.keys()];
    expect(declared).toEqual(["/tree/weight", "/pair/*", "/total"]);
  });

  const declaredOf = (schema: EvaluationOutputSchema) => Object.fromEntries(createEvaluationOutputReader(SCHEMA_REF, schema).declaredFields);

  it("intersects a node with its $ref and allOf members and unites alternatives", () => {
    const schema: EvaluationOutputSchema = {
      $defs: { score: { type: ["number", "null"] } },
      type: "object",
      properties: {
        level: { type: ["string", "null"], allOf: [{ enum: ["a", "b"] }] },
        either: { type: ["number", "boolean"], allOf: [{ type: "number" }] },
        score: { $ref: "#/$defs/score", type: "integer" },
        ratio: { type: "number", enum: [0.5, 1] },
        choice: { anyOf: [{ type: "boolean" }, { enum: ["n/a", null] }] },
      },
    };
    expect(declaredOf(schema)).toEqual({
      "/level": { kinds: ["enum"], values: ["a", "b"], nullable: false },
      "/either": { kinds: ["number"], values: [], nullable: false },
      "/score": { kinds: ["integer"], values: [], nullable: false },
      "/ratio": { kinds: ["number", "enum"], values: [0.5, 1], nullable: false },
      "/choice": { kinds: ["boolean", "enum"], values: [true, false, "n/a"], nullable: true },
    });
    expect(read({ level: null }, schema).validation.status).toBe("invalid");
    expect(observed(read({ ratio: 0.5, choice: null }, schema))).toEqual([["/ratio", "/ratio", "number+enum", 0.5], ["/choice", "/choice", "", null]]);
  });

  it("selects then/else by the containing value and unites both statically", () => {
    const schema: EvaluationOutputSchema = {
      type: "object",
      if: { properties: { mode: { const: "strict" } }, required: ["mode"] },
      then: { properties: { level: { enum: ["a", "b"] } } },
      else: { properties: { level: { enum: ["c", null] } } },
    };
    expect(declaredOf(schema)).toEqual({ "/level": { kinds: ["enum"], values: ["a", "b", "c"], nullable: true } });
    const reader = createEvaluationOutputReader(SCHEMA_REF, schema);
    const strict = evaluation("e1", {}, { mode: "strict", level: "a" });
    expect(reader.read(strict).observations).toEqual([{ jsonPointer: "/level", instancePointer: "/level", kinds: ["enum"], value: "a" }]);
    expect(reader.reachedFields(strict).get("/level")).toEqual({ kinds: ["enum"], values: ["a", "b"], nullable: false });
    expect(read({ mode: "strict", level: null }, schema).validation.status).toBe("invalid");
    const loose = evaluation("e2", {}, { level: null });
    expect(reader.read(loose).observations).toEqual([{ jsonPointer: "/level", instancePointer: "/level", kinds: [], value: null }]);
    expect(reader.reachedFields(loose).get("/level")).toEqual({ kinds: ["enum"], values: ["c"], nullable: true });
  });

  it("applies patternProperties together with properties and additionalProperties of any alternative", () => {
    const overlap: EvaluationOutputSchema = {
      type: "object",
      properties: { a: { type: ["number", "null"] } },
      patternProperties: { "^a": { type: "number" }, "^b": { enum: ["x", null] } },
    };
    expect(declaredOf(overlap)).toEqual({ "/a": { kinds: ["number"], values: [], nullable: false } });
    expect(read({ a: null }, overlap).validation.status).toBe("invalid");
    const reader = createEvaluationOutputReader(SCHEMA_REF, overlap);
    const record = evaluation("e1", {}, { a: 1, b: "x" });
    expect(observed(reader.read(record))).toEqual([["/a", "/a", "number", 1], ["/b", "/b", "enum", "x"]]);
    expect(reader.reachedFields(record).get("/b")).toEqual({ kinds: ["enum"], values: ["x"], nullable: true });

    const branches: EvaluationOutputSchema = { anyOf: [{ properties: { a: { type: "number" } } }, { additionalProperties: { type: ["boolean", "null"] } }] };
    expect(declaredOf(branches)).toEqual({ "/a": { kinds: ["number", "boolean"], values: [true, false], nullable: true } });
    expect(observed(read({ a: true }, branches))).toEqual([["/a", "/a", "boolean", true]]);
    expect(observed(read({ a: null }, branches))).toEqual([["/a", "/a", "", null]]);
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
    expect(view).toMatchObject({ rawJson: null, observations: [], validation: { status: "invalid", reason } });
    expect(view.validation.errors).toHaveLength(1);
  });

  it("keeps parsed JSON visible but unvalidated without a Schema or with an invalid one", () => {
    expect(read({ score: 1 }, null)).toMatchObject({ rawJson: { score: 1 }, validation: { status: "unavailable", reason: "no-schema" }, observations: [] });
    expect(read({ score: 1 }, { type: "nope" })).toMatchObject({ validation: { status: "unavailable", reason: "invalid-schema" } });
  });

  it("extracts no numbers from a failed evaluation even when its output is valid", () => {
    const view = read({ score: 1 }, OUTPUT_SCHEMA, { status: { status: "failed", lastError: "boom" } });
    expect(view.validation.status).toBe("valid");
    expect(view.observations).toEqual([]);
  });
});
