import type { RetryPolicy } from "@eval-platform/eval-contracts";
import { DEFAULT_RETRY_POLICY } from "../config/model.js";
import type { AgentFailureKind } from "../harness/model.js";
import { RuntimeInputError } from "./errors.js";

export type RetryOperation = "creation" | "initialization" | "submission" | "status" | "collection" | "resources" | "persistence" | "restart";

export interface RetryDecision {
  readonly shouldRetry: boolean;
  readonly reason?: AgentFailureKind;
  readonly backoffMs?: number;
}

export interface RetryController {
  decide(input: {
    readonly operation: RetryOperation;
    readonly failureKind: AgentFailureKind;
    readonly attemptNumber: number;
  }): Promise<RetryDecision>;
}

export function requireRetryPolicy(policy: unknown): asserts policy is RetryPolicy {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new RuntimeInputError("retryPolicy must be an object", "retryPolicy");
  }
  const { maxRestarts, initialBackoffMs, maxBackoffMs } = policy as Partial<Record<keyof RetryPolicy, unknown>>;
  if (typeof maxRestarts !== "number" || !Number.isInteger(maxRestarts) || maxRestarts < 0) {
    throw new RuntimeInputError("retryPolicy.maxRestarts must be a non-negative integer", "retryPolicy.maxRestarts");
  }
  if (typeof initialBackoffMs !== "number" || !Number.isFinite(initialBackoffMs) || initialBackoffMs < 0) {
    throw new RuntimeInputError("retryPolicy.initialBackoffMs must be non-negative", "retryPolicy.initialBackoffMs");
  }
  if (typeof maxBackoffMs !== "number" || !Number.isFinite(maxBackoffMs) || maxBackoffMs < initialBackoffMs) {
    throw new RuntimeInputError("retryPolicy.maxBackoffMs must be at least initialBackoffMs", "retryPolicy.maxBackoffMs");
  }
}

export function createRetryController(policy: RetryPolicy = DEFAULT_RETRY_POLICY): RetryController {
  requireRetryPolicy(policy);

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
