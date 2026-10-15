export type BundleFileErrorReason = "not-found" | "too-large" | "invalid" | "unavailable";
export type BundleFileErrorDetail = { readonly path: string; readonly errMsg: string };

/** A Bundle directory read or upload failed; `unavailable` is the only retryable reason. */
export class BundleFileError extends Error {
  readonly retryable: boolean;
  readonly details?: readonly BundleFileErrorDetail[];

  constructor(readonly reason: BundleFileErrorReason, message: string,
    options?: ErrorOptions & { readonly details?: readonly BundleFileErrorDetail[] }) {
    super(message, options);
    this.name = "BundleFileError";
    this.retryable = reason === "unavailable";
    if (options?.details) this.details = options.details;
  }
}

/** The display text of a validation failure reported in a Bundle file error detail. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
