/** Structured diagnostics: identities, counts, statuses, durations and error messages, never payloads. */
export type RuntimeLog = (event: { readonly name: string; readonly [field: string]: unknown }) => void;

/** The Run members a log event or reported error belongs to. */
export interface RuntimeContext {
  readonly runId?: string;
  readonly stage?: "execution" | "evaluation";
  readonly samplingId?: string;
  readonly evaluationId?: string;
}

/** A diagnostic sink must never change the outcome of the operation it describes. */
export function safeLog(log: RuntimeLog | undefined): RuntimeLog {
  return (event) => {
    try {
      log?.(event);
    } catch { /* Diagnostics are best effort. */ }
  };
}

/** Reporting must not change the Run outcome. */
export function reportError(onError: (error: Error) => void, error: Error): void {
  try {
    onError(error);
  } catch (reportingError) {
    console.error(error, reportingError);
  }
}
