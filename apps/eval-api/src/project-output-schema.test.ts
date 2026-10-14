import { describe, expect, it } from "vitest";
import { parseEvaluationOutputSchema } from "./project-output-schema.js";

describe("Project evaluation output JSON Schema", () => {
  it("keeps a detached JSON object for Project binding", () => {
    const input = { type: "object", properties: { score: { type: "number", minimum: 0 } } };
    const result = parseEvaluationOutputSchema(input);
    input.properties.score.minimum = 10;
    expect(result).toEqual({ type: "object", properties: { score: { type: "number", minimum: 0 } } });
  });

  it.each([null, [], "{}", { type: 42 }, { properties: [] },
    { minimum: Infinity }, { minimum: Number.MAX_SAFE_INTEGER + 1 },
    { toJSON: () => ({}) }, { nested: new Date() }])("rejects non-JSON Schema file contents: %j", (value) => {
    expect(() => parseEvaluationOutputSchema(value)).toThrow();
  });
});
