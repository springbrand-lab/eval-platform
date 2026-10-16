import { describe, expect, it } from "vitest";
import type { EvaluationOutputSchema, EvaluationRecord, JsonValue } from "@eval-platform/eval-contracts";
import { evaluation, OUTPUT_SCHEMA, SCHEMA_REF } from "../test-support.js";
import { createEvaluationOutputReader } from "./index.js";

const read = (result: JsonValue | string, schema: EvaluationOutputSchema | null = OUTPUT_SCHEMA, patch: Partial<EvaluationRecord> = {}) =>
  createEvaluationOutputReader(schema && SCHEMA_REF, schema).read(evaluation("evaluation-1", patch, result)).view;
const observed = (view: ReturnType<typeof read>) => view.observations.map(({ jsonPointer, instancePointer, kinds, value }) => (
  [jsonPointer, instancePointer, kinds.join("+"), value]
));
const definitionsOf = (schema: EvaluationOutputSchema) => Object.fromEntries(
  [...createEvaluationOutputReader(SCHEMA_REF, schema).fields].map(([pointer, { kinds, values, nullable }]) => [pointer, { kinds, values, nullable }]),
);

describe("evaluation output validation", () => {
  it("parses, validates and extracts nested, array and $ref numbers with stable pointers", () => {
    const content = JSON.stringify({ score: 7.5, summary: "fine", scores: [{ name: "a", value: 3 }, { name: "b", value: 4 }] });
    const view = read(content);
    expect(view).toMatchObject({
      validation: { status: "valid", reason: "valid", errors: [] }, content,
      rawJson: { score: 7.5, summary: "fine" }, path: "/output/result.json",
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
      ["/result/kind", "/result/kind", "enum", "pass"], ["/result/points", "/result/points", "integer", 9], ["/mixed", "/mixed", "integer", -1],
    ]);
    expect(createEvaluationOutputReader(SCHEMA_REF, schema).fields.get("/result/kind")).toMatchObject({ kinds: ["enum"], values: ["pass", "fail"], nullable: false });
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
    expect(definitionsOf(schema)).toEqual({
      "/passed": { kinds: ["boolean"], values: [true, false], nullable: true },
      "/rating": { kinds: ["integer", "enum"], values: [1, 2, 3], nullable: false },
      "/level": { kinds: ["enum"], values: ["low", "high"], nullable: true },
      "/tags/*": { kinds: ["enum"], values: ["a", "b"], nullable: true },
      "/either": { kinds: ["number", "boolean"], values: [true, false], nullable: false },
      "/checks/*/passed": { kinds: ["boolean"], values: [true, false], nullable: false },
      "/checks/*/note": { kinds: [], values: [], nullable: true },
      "/flag": { kinds: ["boolean"], values: [true], nullable: false },
    });
  });

  it("rejects a null the Schema does not allow, including one excluded by enum", () => {
    const schema: EvaluationOutputSchema = { type: "object", properties: { passed: { type: "boolean" }, level: { type: ["string", "null"], enum: ["low"] } } };
    expect(read({ passed: null }, schema)).toMatchObject({ validation: { status: "invalid", reason: "schema-mismatch" }, observations: [] });
    expect(read({ level: null }, schema).validation.status).toBe("invalid");
    expect(createEvaluationOutputReader(SCHEMA_REF, schema).fields.get("/level")).toMatchObject({ kinds: ["enum"], values: ["low"], nullable: false });
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
    const declared = [...createEvaluationOutputReader(SCHEMA_REF, schema).fields.keys()];
    expect(declared).toEqual(["/tree/weight", "/pair/*", "/total"]);
  });

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
    expect(definitionsOf(schema)).toEqual({
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
    expect(definitionsOf(schema)).toEqual({ "/level": { kinds: ["enum"], values: ["a", "b", "c"], nullable: true } });
    const reader = createEvaluationOutputReader(SCHEMA_REF, schema);
    const strict = evaluation("e1", {}, { mode: "strict", level: "a" });
    expect(reader.read(strict).view.observations).toEqual([{ jsonPointer: "/level", instancePointer: "/level", kinds: ["enum"], value: "a" }]);
    expect(reader.read(strict).facts.fields.get("/level")).toMatchObject({ kinds: ["enum"], values: ["a", "b"], nullable: false });
    expect(read({ mode: "strict", level: null }, schema).validation.status).toBe("invalid");
    const loose = evaluation("e2", {}, { level: null });
    expect(reader.read(loose).view.observations).toEqual([{ jsonPointer: "/level", instancePointer: "/level", kinds: [], value: null }]);
    expect(reader.read(loose).facts.fields.get("/level")).toMatchObject({ kinds: ["enum"], values: ["c"], nullable: true });
  });

  it.each([
    [{ type: "number", anyOf: [{ type: "integer" }, { const: 1 }] }, ["integer", "enum"], [1], "integer+enum"],
    [{ type: "number", anyOf: [{ type: "integer" }, { const: 0.5, enum: [2] }] }, ["integer"], [], "integer"],
    [{ type: "number", anyOf: [{ type: "integer" }, { const: 0.5 }] }, ["number", "enum"], [0.5], "integer"],
    [{ type: "number", enum: [0.5, 1], minimum: 0.6 }, ["integer", "enum"], [1], "integer+enum"],
  ] satisfies [EvaluationOutputSchema, string[], number[], string][])("derives numeric display kinds from every alternative's literal bounds: %j", (schema, kinds, values, observedKinds) => {
    expect(definitionsOf(schema)).toEqual({ "": { kinds, values, nullable: false } });
    expect(observed(read(1, schema))).toEqual([["", "", observedKinds, 1]]);
  });

  it("applies patternProperties together with properties and additionalProperties of any alternative", () => {
    const overlap: EvaluationOutputSchema = {
      type: "object",
      properties: { a: { type: ["number", "null"] } },
      patternProperties: { "^a": { type: "number" }, "^b": { enum: ["x", null] } },
    };
    expect(definitionsOf(overlap)).toEqual({ "/a": { kinds: ["number"], values: [], nullable: false } });
    expect(read({ a: null }, overlap).validation.status).toBe("invalid");
    const reader = createEvaluationOutputReader(SCHEMA_REF, overlap);
    const record = evaluation("e1", {}, { a: 1, b: "x" });
    expect(observed(reader.read(record).view)).toEqual([["/a", "/a", "number", 1], ["/b", "/b", "enum", "x"]]);
    expect(reader.read(record).facts.fields.get("/b")).toMatchObject({ kinds: ["enum"], values: ["x"], nullable: true });

    const branches: EvaluationOutputSchema = { anyOf: [{ properties: { a: { type: "number" } } }, { additionalProperties: { type: ["boolean", "null"] } }] };
    expect(definitionsOf(branches)).toEqual({ "/a": { kinds: ["number", "boolean"], values: [true, false], nullable: true } });
    expect(observed(read({ a: true }, branches))).toEqual([["/a", "/a", "boolean", true]]);
    expect(observed(read({ a: null }, branches))).toEqual([["/a", "/a", "", null]]);
  });

  it("reports a missing output or result file as unavailable", () => {
    const reader = createEvaluationOutputReader(SCHEMA_REF, OUTPUT_SCHEMA);
    const { output, ...pending } = evaluation();
    const { structuredOutput: _file, ...withoutFile } = output!;
    expect(reader.read(pending).view.validation).toEqual({ status: "unavailable", reason: "no-output", errors: [] });
    expect(reader.read({ ...pending, evaluationId: "e2", output: withoutFile }).view).toMatchObject({
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

  it("keeps free text out of an inactive conditional's enum declaration", () => {
    const schema: EvaluationOutputSchema = { if: { const: "a" }, then: { type: "string" }, else: { enum: ["a", "b"] } };
    expect(read('"a"', schema)).toMatchObject({ rawJson: "a", validation: { status: "valid" }, observations: [] });
    expect(observed(read('"b"', schema))).toEqual([["", "", "enum", "b"]]);
  });

  it.each([
    { $defs: { score: { $anchor: "score", type: "number" } }, type: "object", properties: { score: { $ref: "#score" } } },
    {
      $id: "https://eval.example/root.json", $defs: { score: { $id: "score.json", $anchor: "score", type: "number" } },
      type: "object", properties: { score: { $ref: "score.json#score" } },
    },
    { then: { type: "number" }, type: "object", properties: { score: { $ref: "#/then" } } },
  ] satisfies EvaluationOutputSchema[])("uses registered local references, including resource IDs and anchors: %j", (schema) => {
    expect(observed(read({ score: 2 }, schema))).toEqual([["/score", "/score", "number", 2]]);
  });

  it.each([
    { $dynamicAnchor: "node", type: ["boolean", "object"], properties: { flag: { type: "boolean", $dynamicRef: "#node" } } },
    {
      $defs: { node: { $dynamicAnchor: "node", type: ["boolean", "object"], properties: { flag: { type: "boolean", $dynamicRef: "#node" } } } },
      $ref: "#/$defs/node",
    },
  ] satisfies EvaluationOutputSchema[])("retains the declaring root context for dynamic references: %j", (schema) => {
    expect(observed(read({ flag: true }, schema))).toEqual([["/flag", "/flag", "boolean", true]]);
  });

  it("retains outer dynamic-anchor bindings while expanding recursive field templates", () => {
    const schema: EvaluationOutputSchema = {
      $id: "https://eval.example/outer.json", $dynamicAnchor: "node", type: "object",
      properties: { passed: { title: "Passed", type: "boolean" } }, $ref: "#/$defs/base",
      $defs: { base: { $dynamicAnchor: "node", type: "object", properties: { next: { $dynamicRef: "#node" } } } },
    };
    expect(observed(read({ passed: true, next: { passed: false, next: { passed: true } } }, schema))).toEqual([
      ["/passed", "/passed", "boolean", true], ["/next/passed", "/next/passed", "boolean", false],
      ["/next/next/passed", "/next/next/passed", "boolean", true],
    ]);
    expect(read({ next: { passed: "yes" } }, schema).validation.status).toBe("invalid");
  });

  it.each(["$defs", "x-resources"])("uses the root validator's dynamic binding across sibling references into %s", (container) => {
    const schema: EvaluationOutputSchema = {
      $id: "https://eval.example/root", allOf: [{ $ref: `#/${container}/a` }, { $ref: `#/${container}/b` }],
      [container]: {
        a: { $id: "a", $dynamicAnchor: "node", type: "object", properties: { a: { type: "boolean" } } },
        b: {
          $id: "b", $dynamicAnchor: "node", type: "object", $defs: { dynamic: { $dynamicRef: "#node" } },
          properties: { b: { type: "boolean" }, child: { $ref: "#/$defs/dynamic" } },
        },
      },
    };
    expect(observed(read({ a: false, b: true, child: { a: true } }, schema))).toEqual([
      ["/a", "/a", "boolean", false], ["/b", "/b", "boolean", true], ["/child/a", "/child/a", "boolean", true],
    ]);
    expect(read({ child: { b: true } }, schema)).toMatchObject({ validation: { status: "valid" }, observations: [] });
    expect(read({ child: { a: "bad" } }, schema).validation.status).toBe("invalid");
  });

  it.each(["$defs", "x-resources"])("retains dynamic bindings introduced by an unsuccessful alternative in %s", (container) => {
    const schema: EvaluationOutputSchema = {
      $id: "https://eval.example/root", anyOf: [{ $ref: `#/${container}/a` }, { $ref: `#/${container}/b` }],
      [container]: {
        a: { $id: "a", $dynamicAnchor: "node", type: "object", properties: { mode: { const: "a" }, flag: { type: "boolean" } }, required: ["mode"] },
        b: { $id: "b", $dynamicAnchor: "node", type: "object", properties: { mode: { const: "b" }, score: { type: "number" }, child: { $dynamicRef: "#node" } }, required: ["mode"] },
      },
    };
    expect(observed(read({ mode: "b", score: 3, child: { mode: "a", flag: true } }, schema))).toEqual([
      ["/mode", "/mode", "enum", "b"], ["/score", "/score", "number", 3],
      ["/child/mode", "/child/mode", "enum", "a"], ["/child/flag", "/child/flag", "boolean", true],
    ]);
  });

  it.each([["early", "late"], ["early", "late", "early"]])("keeps occurrence-time dynamic targets when a later reference adds a binding: %j", (...references: string[]) => {
    const schema: EvaluationOutputSchema = {
      $id: "https://eval.example/root", allOf: references.map(($ref) => ({ $ref })),
      $defs: {
        early: {
          $id: "early", type: "object", $defs: { anchor: { $dynamicAnchor: "node", type: "object" } },
          properties: { early: { type: "boolean" }, child: { $dynamicRef: "#node" } },
        },
        late: { $id: "late", $dynamicAnchor: "node", type: "object", properties: { late: { type: "number" } } },
      },
    };
    const result = read({ early: true, late: 4, child: { early: false, late: "free" } }, schema);
    expect(result.validation.status).toBe("valid");
    expect(observed(result)).toEqual([
      ["/early", "/early", "boolean", true], ["/late", "/late", "number", 4], ["/child/early", "/child/early", "boolean", false],
    ]);
    expect(read({ child: { early: "bad", late: 5 } }, schema).validation.status).toBe("invalid");
  });

  it("preserves the caller's Schema and literal JSON while recording validation execution", () => {
    const literal = { "x-eval-metrics-trace-start": true, properties: { flag: { type: "boolean" } } };
    const schema: EvaluationOutputSchema = { type: "object", properties: { payload: { const: literal }, passed: { type: "boolean" } } };
    const original = structuredClone(schema);
    expect(observed(read({ payload: literal, passed: true }, schema))).toEqual([["/passed", "/passed", "boolean", true]]);
    expect(schema).toEqual(original);
    expect(read({ payload: {}, passed: true }, schema).validation.status).toBe("invalid");
  });

  it.each([3, { $ref: "#/x/value", title: "Literal alias" }])("preserves an object used as both literal JSON and a reference target: %j", (value) => {
    const schema: EvaluationOutputSchema = {
      anyOf: [{ const: { $ref: "#/x/value", title: "Literal alias" } }, { $ref: "#/anyOf/0/const" }], x: { value: { type: "number" } },
    };
    const result = read(value, schema);
    expect(result.validation.status).toBe("valid");
    expect(observed(result)).toEqual(typeof value === "number" ? [["", "", "number", 3]] : []);
  });

  it("keeps keyword maps separate from their Schema values", () => {
    const schema: EvaluationOutputSchema = {
      type: "object", dependentRequired: { passed: ["score"] }, properties: { passed: { type: "boolean" }, score: { type: "number" } },
    };
    expect(observed(read({ passed: true, score: 2 }, schema))).toEqual([["/passed", "/passed", "boolean", true], ["/score", "/score", "number", 2]]);
    expect(read({ passed: true }, schema).validation.status).toBe("invalid");
  });

  it("defers context-dependent candidates without rejecting a valid Schema", () => {
    const schema: EvaluationOutputSchema = {
      type: "object", $defs: { target: { anyOf: [{ type: "boolean", $dynamicRef: "#node" }, {}] } },
      properties: { first: { $dynamicAnchor: "node", type: "number" }, second: { $ref: "#/$defs/target" } },
    };
    const reader = createEvaluationOutputReader(SCHEMA_REF, schema);
    expect([...reader.fields.keys()]).toEqual(["/first"]);
    expect(reader.read(evaluation("e", {}, { first: 1, second: true })).view).toMatchObject({
      validation: { status: "valid" }, observations: [{ jsonPointer: "/first", value: 1, kinds: ["number"] }],
    });
  });

  it("ignores unexecuted definitions and annotation JSON when checking candidate dependencies", () => {
    const schema: EvaluationOutputSchema = {
      type: "boolean", default: { $dynamicRef: "#unused" }, $defs: { unused: { $dynamicRef: "#unused" } },
    };
    expect(definitionsOf(schema)).toEqual({ "": { kinds: ["boolean"], values: [true, false], nullable: false } });
    expect(observed(read(true, schema))).toEqual([["", "", "boolean", true]]);
  });

  it.each([true, { type: "boolean" }])("distinguishes simultaneous dynamic and ordinary references: %j", (allowed) => {
    const schema: EvaluationOutputSchema = {
      $dynamicAnchor: "node", type: ["object", "boolean"], $defs: { allowed },
      properties: { flag: { type: "boolean", $dynamicRef: "#node", $ref: "#/$defs/allowed" } },
    };
    expect(observed(read({ flag: true }, schema))).toEqual([["/flag", "/flag", "boolean", true]]);
  });

  it("does not reuse a failed boolean reference as the next reference's invocation", () => {
    const schema: EvaluationOutputSchema = {
      type: "object", $defs: { no: false, flag: { type: "boolean" } },
      properties: { flag: { if: { $ref: "#/$defs/no" }, then: false, else: { $ref: "#/$defs/flag" } } },
    };
    expect(observed(read({ flag: true }, schema))).toEqual([["/flag", "/flag", "boolean", true]]);
  });
});
