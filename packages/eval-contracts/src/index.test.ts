import { describe, expect, it } from "vitest";
import {
  AGENT_STATUSES,
  PENDING_SAMPLING_STATUSES,
  SAMPLING_STATUSES,
  TERMINAL_AGENT_STATUSES,
  isIdentifier,
  isPendingSamplingStatus,
  isTerminalAgentStatus,
  jsonObjectSchema,
  jsonValueSchema,
} from "./index.js";

describe("@eval-platform/eval-contracts", () => {
  it("classifies every Sampling status against the single pending set", () => {
    expect(SAMPLING_STATUSES.filter(isPendingSamplingStatus)).toEqual(PENDING_SAMPLING_STATUSES);
  });

  it("classifies every Agent status against the single terminal set", () => {
    expect(AGENT_STATUSES.filter(isTerminalAgentStatus)).toEqual(TERMINAL_AGENT_STATUSES);
  });

  it.each(["id", "a b"])("accepts identifier %j", (value) => expect(isIdentifier(value)).toBe(true));
  it.each(["", " ", " id", "id ", 1, null])("rejects identifier %j", (value) => expect(isIdentifier(value)).toBe(false));

  it("accepts acyclic plain JSON with shared values and returns a detached copy", () => {
    const shared = { tokens: [1, 0.5, null] };
    const input = { first: shared, second: shared, nested: [[{ ok: true }]] };
    const parsed = jsonValueSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(input));
  });

  it.each([
    undefined,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
    1n,
    new Date(),
    new Array(2),
    Object.assign([1], { extra: true }),
    { [Symbol("key")]: 1 },
    Object.defineProperty({}, "hidden", { value: 1 }),
    { get computed() { return 1; } },
    { toJSON: () => "converted" },
  ])("rejects non-JSON value %#", (value) => {
    expect(jsonValueSchema.safeParse(value).success).toBe(false);
  });

  it("rejects cycles and deep nesting without stack overflow", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonValueSchema.safeParse(cyclic).success).toBe(false);
    let deep: unknown = 1;
    for (let depth = 0; depth < 100_000; depth += 1) deep = [deep];
    expect(jsonValueSchema.safeParse(deep).success).toBe(true);
  });

  it.each([null, [], "text"])("requires a top-level JSON object: %j", (value) => {
    expect(jsonObjectSchema.safeParse(value).success).toBe(false);
  });
});
