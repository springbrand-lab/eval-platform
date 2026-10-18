import { describe, expect, it, vi } from "vitest";
import { RuntimeInputError } from "./errors.js";
import { createRetryController, DEFAULT_RETRY_POLICY, retryIdempotentOperation } from "./retry.js";

describe("retry controller", () => {
  it("retries a shared idempotent operation with the fixed transient budget", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await retryIdempotentOperation({
      operation: "persistence",
      run: async () => {
        calls += 1;
        if (calls <= 10) throw new Error("temporary database failure");
        return "saved";
      },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });

    expect(result).toBe("saved");
    expect(calls).toBe(11);
    expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000, 10_000]);
  });

  it("does not retry an operation that marks its failure as permanent", async () => {
    const run = async () => { throw Object.assign(new Error("invalid facts"), { retryable: false }); };

    await expect(retryIdempotentOperation({
      operation: "persistence", run, sleep: async () => undefined,
    })).rejects.toThrow("invalid facts");
  });

  it("does not reconcile a permanent failure", async () => {
    const reconcile = vi.fn(async () => "unexpected");

    await expect(retryIdempotentOperation({
      operation: "submission",
      run: async () => { throw Object.assign(new Error("request rejected"), { retryable: false }); },
      reconcile,
      sleep: async () => undefined,
    })).rejects.toThrow("request rejected");

    expect(reconcile).not.toHaveBeenCalled();
  });

  it("uses ten transient retries with bounded backoff", async () => {
    const controller = createRetryController();
    const decisions = await Promise.all(Array.from({ length: 11 }, (_, index) => controller.decide({
      operation: "collection",
      failureKind: "network",
      attemptNumber: index + 1,
    })));

    expect(DEFAULT_RETRY_POLICY).toEqual({ maxRestarts: 4, initialBackoffMs: 250, maxBackoffMs: 10_000 });
    expect(decisions.slice(0, 10)).toEqual([
      { shouldRetry: true, reason: "network", backoffMs: 250 },
      { shouldRetry: true, reason: "network", backoffMs: 500 },
      { shouldRetry: true, reason: "network", backoffMs: 1_000 },
      { shouldRetry: true, reason: "network", backoffMs: 2_000 },
      { shouldRetry: true, reason: "network", backoffMs: 4_000 },
      { shouldRetry: true, reason: "network", backoffMs: 8_000 },
      { shouldRetry: true, reason: "network", backoffMs: 10_000 },
      { shouldRetry: true, reason: "network", backoffMs: 10_000 },
      { shouldRetry: true, reason: "network", backoffMs: 10_000 },
      { shouldRetry: true, reason: "network", backoffMs: 10_000 },
    ]);
    expect(decisions[10]).toEqual({ shouldRetry: false, reason: "network" });
    expect(decisions.slice(0, 10).reduce((total, decision) => total + (decision.backoffMs ?? 0), 0)).toBe(55_750);
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
