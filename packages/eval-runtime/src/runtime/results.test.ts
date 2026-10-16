import { describe, expect, it } from "vitest";
import { extractFinalReplyResult } from "./results.js";

describe("extractFinalReplyResult", () => {
  it("takes the last fenced JSON block that parses", () => {
    const reply = "Draft:\n```json\n{\"score\": 1}\n```\nFinal:\n```json\n{\"score\": 2}\n```\n```json\nnot json\n```";
    expect(extractFinalReplyResult(reply)).toBe('{"score": 2}');
  });

  it("accepts an unlabelled fence and a bare JSON reply", () => {
    expect(extractFinalReplyResult("```\n[1, 2]\n```")).toBe("[1, 2]");
    expect(extractFinalReplyResult('  {"score": 3}\n')).toBe('{"score": 3}');
  });

  it("finds nothing in prose", () => {
    expect(extractFinalReplyResult("I could not finish the evaluation.")).toBeUndefined();
    expect(extractFinalReplyResult("")).toBeUndefined();
  });
});
