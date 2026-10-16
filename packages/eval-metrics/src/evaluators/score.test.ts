import { describe, expect, it } from "vitest";
import { evaluation } from "../test-support.js";
import { createEvaluationScoreReader } from "./score.js";

describe("optional evaluation score", () => {
  it("isolates schemas with the same ID and reads only a conforming raw result", () => {
    const read = createEvaluationScoreReader();
    const first = { $id: "https://eval.example/output", type: "object", properties: { score: { type: "number", maximum: 10 } } };
    const second = { ...first, properties: { score: { type: "number", maximum: 5 } } };
    expect(read(first, evaluation("one", {}, { score: 8, reason: "ok" }))).toEqual({ score: 8, reason: "ok" });
    expect(read(second, evaluation("two", {}, { score: 8 }))).toBeUndefined();
    expect(read(second, evaluation("three", {}, { score: 0 }))).toEqual({ score: 0 });
  });

  it.each([
    '{"score":1,"score":2}',
    '{"score":8,"extra":9007199254740992}',
    '{"score":8,"extra":1e400}',
    'true',
    '{"verdict":"pass"}',
  ])("does not invent a score for %s", (content) => {
    expect(createEvaluationScoreReader()({}, evaluation("one", {}, content))).toBeUndefined();
  });

  it("does not score failed Evaluations or missing result files", () => {
    const read = createEvaluationScoreReader();
    expect(read({}, evaluation("failed", { status: { status: "failed" } }, { score: 8 }))).toBeUndefined();
    const { output: _output, ...missing } = evaluation("missing");
    expect(read({}, missing)).toBeUndefined();
  });
});
