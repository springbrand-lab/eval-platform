import { describe, expect, it } from "vitest";
import { createEvaluationResultValidator } from "./index.js";

describe("evaluation result validator", () => {
  const schema = { type: "object", required: ["score"], properties: { score: { type: "number", maximum: 10 } }, additionalProperties: false };

  it("accepts a conforming result and reports Schema errors", () => {
    const validate = createEvaluationResultValidator();
    expect(validate(schema, '{"score":8}')).toEqual({ status: "valid", reason: "valid", errors: [] });
    const mismatch = validate(schema, '{"score":11,"extra":true}');
    expect(mismatch.status).toBe("invalid");
    expect(mismatch.reason).toBe("schema-mismatch");
    expect(mismatch.errors.map((error) => error.keyword).sort()).toEqual(["additionalProperties", "maximum"]);
  });

  it("rejects duplicate keys and unsafe numbers before the Schema", () => {
    const validate = createEvaluationResultValidator();
    expect(validate(schema, '{"score":1,"score":2}').reason).toBe("invalid-json");
    expect(validate(schema, '{"score":1e400}').reason).toBe("unsafe-number");
  });

  it("reports an uncompilable Schema as unavailable", () => {
    expect(createEvaluationResultValidator()({ type: 7 } as never, "{}").status).toBe("unavailable");
  });
});
