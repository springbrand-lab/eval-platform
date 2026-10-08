import { DEFAULT_RETRY_POLICY } from "../config/model.js";

export { DEFAULT_RETRY_POLICY } from "../config/model.js";

export type RetryableFailureKind = "network" | "llm" | "website" | "submission-timeout";

export type RetryOperation = "creation" | "initialization" | "submission" | "status" | "collection" | "resources" | "persistence" | "restart";

export interface RetryDecision {
  readonly shouldRetry: boolean;
  readonly reason?: RetryableFailureKind;
  readonly backoffMs?: number;
}

export interface RetryController {
  decide(input: {
    readonly operation: RetryOperation;
    readonly failureKind: RetryableFailureKind;
    readonly attemptNumber: number;
  }): Promise<RetryDecision>;
}

export function createRetryController(
  policy: {
    readonly maxRestarts: number;
    readonly initialBackoffMs: number;
    readonly maxBackoffMs: number;
  } = DEFAULT_RETRY_POLICY,
): RetryController {
  if (!Number.isInteger(policy.maxRestarts) || policy.maxRestarts < 0) {
    throw new Error("maxRestarts must be a non-negative integer");
  }
  if (!Number.isFinite(policy.initialBackoffMs) || policy.initialBackoffMs < 0) {
    throw new Error("initialBackoffMs must be non-negative");
  }
  if (!Number.isFinite(policy.maxBackoffMs) || policy.maxBackoffMs < policy.initialBackoffMs) {
    throw new Error("maxBackoffMs must be at least initialBackoffMs");
  }

  return {
    async decide(input) {
      if (input.operation !== "restart") {
        return { shouldRetry: false, reason: input.failureKind };
      }

      const shouldRetry = input.attemptNumber <= policy.maxRestarts;
      if (!shouldRetry) return { shouldRetry: false, reason: input.failureKind };
      const backoffMs = Math.min(
        policy.maxBackoffMs,
        policy.initialBackoffMs * 2 ** Math.max(0, input.attemptNumber - 1),
      );
      return { shouldRetry: true, reason: input.failureKind, backoffMs };
    },
  };
}
