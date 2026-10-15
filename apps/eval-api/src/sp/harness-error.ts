import type { AgentFailureKind } from "@eval-platform/eval-runtime/harness";

/** An Eval SP Harness operation failed; `retryable` says whether repeating the idempotent operation may succeed. */
export class SpHarnessError extends Error {
  readonly failureKind: AgentFailureKind;
  readonly status: number | undefined;

  constructor(
    message: string,
    readonly retryable: boolean,
    details: { readonly failureKind?: AgentFailureKind; readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "SpHarnessError";
    this.failureKind = details.failureKind ?? "network";
    this.status = details.status;
  }
}
