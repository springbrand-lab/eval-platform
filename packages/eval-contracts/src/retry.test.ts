import { describe, expect, it } from "vitest";
import { IDEMPOTENT_RETRY_POLICY, idempotentRetryBackoffMs } from "./index.js";

describe("shared idempotent retry policy", () => {
  it("owns the recovery budget and capped exponential schedule", () => {
    expect(IDEMPOTENT_RETRY_POLICY).toEqual({ maxRetries: 10, initialBackoffMs: 250, maxBackoffMs: 10_000 });
    expect(Array.from({ length: 10 }, (_, index) => idempotentRetryBackoffMs(index + 1))).toEqual([
      250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000, 10_000,
    ]);
  });

  it("preserves the first-delay clamp and caps later retries", () => {
    expect(idempotentRetryBackoffMs(0)).toBe(250);
    expect(idempotentRetryBackoffMs(100)).toBe(10_000);
  });
});
