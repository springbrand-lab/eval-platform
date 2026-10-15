import { describe, expect, it } from "vitest";
import { RuntimeInputError } from "./errors.js";
import { createRetryController } from "./retry.js";

describe("retry controller", () => {
  it("caps restarts and applies exponential backoff", async () => {
    const controller = createRetryController({ maxRestarts: 2, initialBackoffMs: 10, maxBackoffMs: 15 });

    await expect(controller.decide({
      operation: "restart",
      failureKind: "network",
      attemptNumber: 1,
    })).resolves.toEqual({
      shouldRetry: true,
      reason: "network",
      backoffMs: 10,
    });
    await expect(controller.decide({
      operation: "restart",
      failureKind: "network",
      attemptNumber: 2,
    })).resolves.toEqual({
      shouldRetry: true,
      reason: "network",
      backoffMs: 15,
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

  it.each(["creation", "initialization", "submission", "status", "collection", "resources", "persistence"] as const)(
    "does not prescribe %s retries or spend the restart allowance on them",
    async (operation) => {
      const controller = createRetryController({
        maxRestarts: 2,
        initialBackoffMs: 10,
        maxBackoffMs: 15,
      });
      const failureKind = operation === "status" ? "submission-timeout" : "network";

      await expect(controller.decide({
        operation,
        failureKind,
        attemptNumber: 1,
      })).resolves.toEqual({
        shouldRetry: false,
        reason: failureKind,
      });
      await expect(controller.decide({
        operation: "restart",
        failureKind: "network",
        attemptNumber: 1,
      })).resolves.toEqual({
        shouldRetry: true,
        reason: "network",
        backoffMs: 10,
      });
    },
  );

  it.each([
    [{ maxRestarts: -1, initialBackoffMs: 0, maxBackoffMs: 0 }, "retryPolicy.maxRestarts"],
    [{ maxRestarts: 1, initialBackoffMs: -1, maxBackoffMs: 0 }, "retryPolicy.initialBackoffMs"],
    [{ maxRestarts: 1, initialBackoffMs: 10, maxBackoffMs: 5 }, "retryPolicy.maxBackoffMs"],
  ])("rejects invalid policy %j on %s with the shared config validation", (policy, field) => {
    expect(() => createRetryController(policy)).toThrow(RuntimeInputError);
    expect(() => createRetryController(policy)).toThrow(expect.objectContaining({ field }));
  });
});
