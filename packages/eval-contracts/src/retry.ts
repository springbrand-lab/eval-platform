export const IDEMPOTENT_RETRY_POLICY = {
  maxRetries: 10,
  initialBackoffMs: 250,
  maxBackoffMs: 10_000,
} as const;

export function idempotentRetryBackoffMs(attemptNumber: number): number {
  return Math.min(
    IDEMPOTENT_RETRY_POLICY.maxBackoffMs,
    IDEMPOTENT_RETRY_POLICY.initialBackoffMs * 2 ** Math.max(0, attemptNumber - 1),
  );
}
