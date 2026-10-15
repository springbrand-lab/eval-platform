export type BundleFileErrorReason = "not-found" | "conflict" | "too-large" | "invalid" | "unavailable";

/** A Bundle directory read or upload failed; `unavailable` is the only retryable reason. */
export class BundleFileError extends Error {
  readonly retryable: boolean;

  constructor(readonly reason: BundleFileErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BundleFileError";
    this.retryable = reason === "unavailable";
  }
}
