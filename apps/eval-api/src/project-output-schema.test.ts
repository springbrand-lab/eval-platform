import { describe, expect, it } from "vitest";
import { CatalogInputError, CatalogPayloadTooLargeError } from "./db/errors.js";
import { OUTPUT_SCHEMA_BYTES } from "./limits.js";
import { parseEvaluationOutputSchema, validateEvaluationResult } from "./project-output-schema.js";

describe("Project evaluation output JSON Schema", () => {
  it("parses a JSON Schema object for Project binding", () => {
    expect(parseEvaluationOutputSchema('{"type":"object","properties":{"score":{"type":"number","minimum":0}}}'))
      .toEqual({ type: "object", properties: { score: { type: "number", minimum: 0 } } });
  });

  it.each(["null", "[]", '"{}"', '{"type":42}', '{"properties":[]}', '{"minimum":1e400}',
    `{"minimum":${Number.MAX_SAFE_INTEGER + 2}}`, '{"a":1,"a":2}', "{"])("rejects invalid JSON Schema file contents: %s", (content) => {
    expect(() => parseEvaluationOutputSchema(content)).toThrow(CatalogInputError);
  });

  it("rejects a Schema file beyond the output-format size limit", () => {
    expect(() => parseEvaluationOutputSchema(JSON.stringify({ description: "a".repeat(OUTPUT_SCHEMA_BYTES) })))
      .toThrow(CatalogPayloadTooLargeError);
  });
});

describe("Evaluator result validation", () => {
  const schema = parseEvaluationOutputSchema(JSON.stringify({
    type: "object",
    required: ["score", "reason"],
    properties: { score: { type: "number", minimum: 0, maximum: 10 }, reason: { type: "string" } },
  }));

  it("accepts a conforming result", () => {
    expect(validateEvaluationResult(schema, { score: 8, reason: "ok" })).toEqual([]);
  });

  it("lists every problem with its location", () => {
    expect(validateEvaluationResult(schema, { score: 11 })).toEqual([
      "/ must have required property 'reason'",
      "/score must be <= 10",
    ]);
  });
});
