import type { RetryPolicy } from "@eval-platform/eval-contracts";
import { AGENT_FAILURE_KINDS, type AgentFailureKind } from "../harness/model.js";
import { RuntimeInputError } from "./errors.js";
import { requireObject } from "./input.js";
import type { RuntimeLog } from "./log.js";

const TRANSIENT_RETRY_COUNT = 10;

export const DEFAULT_RETRY_POLICY = {
  maxRestarts: 4,
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
    /** Message of the failure being decided, for diagnostics only. */
    readonly error?: string;
  }): Promise<RetryDecision>;
}

/** Reports every decision: `operation_retry` before a backoff, `retry_exhausted` when the budget is spent. */
export function loggedRetryController(controller: RetryController, log: RuntimeLog): RetryController {
  return {
    async decide(input) {
      const decision = await controller.decide(input);
      const { operation, attemptNumber, failureKind, error } = input;
      const fields = { operation, attemptNumber, failureKind, ...(error === undefined ? {} : { error }) };
      log(decision.shouldRetry
        ? { name: "operation_retry", ...fields, backoffMs: decision.backoffMs ?? 0 }
        : { name: "retry_exhausted", ...fields });
      return decision;
    },
  };
}

export interface RetryErrorDetails {
  readonly message: string;
  readonly retryable: boolean;
  readonly failureKind: AgentFailureKind;
}

export interface IdempotentRetryLoop<TResult> {
  readonly operation: RetryOperation;
  readonly run: () => Promise<TResult>;
  readonly retryController?: RetryController;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly reconcile?: () => Promise<TResult | undefined>;
  readonly onRetry?: (message: string) => Promise<void>;
  readonly describeError?: (error: unknown) => RetryErrorDetails;
  readonly shouldAbort?: (error: unknown) => boolean;
  readonly fail?: (error: unknown, details: RetryErrorDetails) => unknown;
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

/** Repeats one idempotent operation with Runtime's fixed transient retry budget and backoff. */
export async function retryIdempotentOperation<TResult>(loop: IdempotentRetryLoop<TResult>): Promise<TResult> {
  const retryController = loop.retryController ?? createRetryController();
  const sleep = loop.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await loop.run();
    } catch (error) {
      if (loop.shouldAbort?.(error)) throw error;
      const details = loop.describeError?.(error) ?? describeRetryError(error);
      // Reconciliation is only meaningful for an uncertain transient failure.
      // A permanent rejection must be returned as-is; probing the operation key
      // can both add an unnecessary request and mask an identity/validation error.
      if (!details.retryable) throw loop.fail?.(error, details) ?? error;
      const reconciled = await loop.reconcile?.();
      if (reconciled !== undefined) return reconciled;
      const decision = await retryController.decide({
        operation: loop.operation,
        failureKind: details.failureKind,
        attemptNumber,
        error: details.message,
      });
      if (!decision?.shouldRetry) throw loop.fail?.(error, details) ?? error;
      await loop.onRetry?.(details.message);
      await sleep(decision.backoffMs ?? 0);
    }
  }
}

export function describeRetryError(error: unknown): RetryErrorDetails {
  if (error instanceof Error) {
    const candidate = error as Error & { readonly retryable?: unknown; readonly failureKind?: unknown };
    return {
      message: error.message,
      retryable: candidate.retryable !== false,
      failureKind: isAgentFailureKind(candidate.failureKind) ? candidate.failureKind : "network",
    };
  }
  return { message: String(error), retryable: true, failureKind: "network" };
}

function isAgentFailureKind(value: unknown): value is AgentFailureKind {
  return typeof value === "string" && AGENT_FAILURE_KINDS.includes(value as AgentFailureKind);
}
