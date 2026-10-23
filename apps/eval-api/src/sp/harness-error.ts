import type { AgentFailureKind } from "@eval-platform/eval-runtime/harness";

/** An Eval SP Harness operation failed; `retryable` says whether repeating the idempotent operation may succeed. */
export class SpHarnessError extends Error {
  readonly failureKind: AgentFailureKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  /** SP's `Retry-After` hint, when it sent one; Runtime's own backoff still governs the next attempt. */
  readonly retryAfterMs: number | undefined;
  /** SP's `X-Request-ID` and Cloudflare's `cf-ray` of the failed response, for cross-system correlation. */
  readonly requestId: string | undefined;
  readonly cfRay: string | undefined;

  constructor(
    message: string,
    readonly retryable: boolean,
    details: {
      readonly failureKind?: AgentFailureKind;
      readonly status?: number;
      readonly code?: string;
      readonly retryAfterMs?: number;
      readonly requestId?: string;
      readonly cfRay?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "SpHarnessError";
    this.failureKind = details.failureKind ?? "network";
    this.status = details.status;
    this.code = details.code;
    this.retryAfterMs = details.retryAfterMs;
    this.requestId = details.requestId;
    this.cfRay = details.cfRay;
  }
}
