import { describe, expect, it } from "vitest";
import { RuntimeInputError } from "./errors.js";
import { createRetryController, DEFAULT_RETRY_POLICY } from "./retry.js";

describe("retry controller", () => {
  it("uses seven transient retries with a bounded backoff near thirty seconds", async () => {
    const controller = createRetryController();
    const decisions = await Promise.all(Array.from({ length: 8 }, (_, index) => controller.decide({
      operation: "collection",
      failureKind: "network",
      attemptNumber: index + 1,
    })));

    expect(DEFAULT_RETRY_POLICY).toEqual({ maxRestarts: 2, initialBackoffMs: 250, maxBackoffMs: 10_000 });
    expect(decisions.slice(0, 7)).toEqual([
      { shouldRetry: true, reason: "network", backoffMs: 250 },
      { shouldRetry: true, reason: "network", backoffMs: 500 },
      { shouldRetry: true, reason: "network", backoffMs: 1_000 },
      { shouldRetry: true, reason: "network", backoffMs: 2_000 },
      { shouldRetry: true, reason: "network", backoffMs: 4_000 },
      { shouldRetry: true, reason: "network", backoffMs: 8_000 },
      { shouldRetry: true, reason: "network", backoffMs: 10_000 },
    ]);
    expect(decisions[7]).toEqual({ shouldRetry: false, reason: "network" });
    expect(decisions.slice(0, 7).reduce((total, decision) => total + (decision.backoffMs ?? 0), 0)).toBe(25_750);
  });

  it("caps restarts and applies exponential backoff", async () => {
    const controller = createRetryController({ maxRestarts: 2, initialBackoffMs: 0, maxBackoffMs: 0 });

    await expect(controller.decide({
      operation: "restart",
      failureKind: "network",
      attemptNumber: 1,
    })).resolves.toEqual({
      shouldRetry: true,
      reason: "network",
      backoffMs: 250,
    });
    await expect(controller.decide({
      operation: "restart",
      failureKind: "network",
      attemptNumber: 2,
    })).resolves.toEqual({
      shouldRetry: true,
      reason: "network",
      backoffMs: 500,
    });
    await expect(controller.decide({
      operation: "restart",
      failureKind: "network",
      attemptNumber: 3,
    })).resolves.toEqual({
      shouldRetry: false,
      reason: "network",
    });
  });

  it.each(["creation", "initialization", "submission", "status", "collection", "resources", "persistence", "stop"] as const)(
    "retries idempotent %s operations without spending the restart allowance",
    async (operation) => {
      const controller = createRetryController({
        maxRestarts: 2,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
      });
      const failureKind = operation === "status" ? "submission-timeout" : "network";

      await expect(controller.decide({
        operation,
        failureKind,
        attemptNumber: 1,
      })).resolves.toEqual({
        shouldRetry: true,
        reason: failureKind,
        backoffMs: 250,
      });
      await expect(controller.decide({
        operation: "restart",
        failureKind: "network",
        attemptNumber: 1,
      })).resolves.toEqual({
        shouldRetry: true,
        reason: "network",
        backoffMs: 250,
      });
    },
  );

  it.each([
    [{ maxRestarts: -1, initialBackoffMs: 0, maxBackoffMs: 0 }, "retryPolicy.maxRestarts"],
  ])("rejects invalid policy %j on %s with the shared config validation", (policy, field) => {
    expect(() => createRetryController(policy)).toThrow(RuntimeInputError);
    expect(() => createRetryController(policy)).toThrow(expect.objectContaining({ field }));
  });
});
