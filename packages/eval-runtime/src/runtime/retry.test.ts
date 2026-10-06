import { describe, expect, it } from "vitest";
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

  it("does not prescribe creation, submission, status or collection retries", async () => {
    const controller = createRetryController({
      maxRestarts: 2,
      initialBackoffMs: 10,
      maxBackoffMs: 15,
    });

    await expect(controller.decide({
      operation: "creation",
      failureKind: "network",
      attemptNumber: 1,
    })).resolves.toEqual({
      shouldRetry: false,
      reason: "network",
    });
    await expect(controller.decide({
      operation: "submission",
      failureKind: "network",
      attemptNumber: 1,
    })).resolves.toEqual({
      shouldRetry: false,
      reason: "network",
    });
    await expect(controller.decide({
      operation: "status",
      failureKind: "submission-timeout",
      attemptNumber: 1,
    })).resolves.toEqual({
      shouldRetry: false,
      reason: "submission-timeout",
    });
    await expect(controller.decide({
      operation: "collection",
      failureKind: "network",
      attemptNumber: 1,
    })).resolves.toEqual({
      shouldRetry: false,
      reason: "network",
    });
  });
});
