import type { RetryPolicy } from "@eval-platform/eval-contracts";
import type { AgentFailureKind } from "../harness/model.js";
import { RuntimeInputError } from "./errors.js";
import { requireObject } from "./input.js";

const TRANSIENT_RETRY_COUNT = 7;

export const DEFAULT_RETRY_POLICY = {
  maxRestarts: 2,
  initialBackoffMs: 250,
  maxBackoffMs: 10_000,
} as const satisfies RetryPolicy;

export type RetryOperation = "creation" | "initialization" | "submission" | "status" | "collection" | "resources" | "persistence" | "stop" | "restart";

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
  requireObject(policy, "retryPolicy");
  const { maxRestarts } = policy as Partial<Record<keyof RetryPolicy, unknown>>;
  if (typeof maxRestarts !== "number" || !Number.isInteger(maxRestarts) || maxRestarts < 0) {
    throw new RuntimeInputError("retryPolicy.maxRestarts must be a non-negative integer", "retryPolicy.maxRestarts");
  }
}

export function createRetryController(policy: RetryPolicy = DEFAULT_RETRY_POLICY): RetryController {
  requireRetryPolicy(policy);

  return {
    async decide(input) {
      const maxRetries = input.operation === "restart"
        ? policy.maxRestarts
        : TRANSIENT_RETRY_COUNT;

      const shouldRetry = input.attemptNumber <= maxRetries;
      if (!shouldRetry) return { shouldRetry: false, reason: input.failureKind };
      const backoffMs = Math.min(
        DEFAULT_RETRY_POLICY.maxBackoffMs,
        DEFAULT_RETRY_POLICY.initialBackoffMs * 2 ** Math.max(0, input.attemptNumber - 1),
      );
      return { shouldRetry: true, reason: input.failureKind, backoffMs };
    },
  };
}
