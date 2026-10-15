export type RuntimeEntity =
  | "project"
  | "run"
  | "sample"
  | "sampling"
  | "evaluation"
  | "execution-config"
  | "evaluation-config"
  | "pipeline-config";

/** A Runtime read or admission named an entity that is absent from the caller's scope. */
export class RuntimeEntityNotFoundError extends Error {
  readonly retryable = false;

  constructor(readonly entity: RuntimeEntity, readonly id: string) {
    super(`Unknown ${entity} ${id}`);
    this.name = "RuntimeEntityNotFoundError";
  }
}

/** Caller-supplied request or configuration facts are invalid. */
export class RuntimeInputError extends Error {
  readonly retryable = false;

  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "RuntimeInputError";
  }
}

export type RuntimeAdmissionConflictReason =
  | "source-branch"
  | "launch-selection"
  | "output-schema"
  | "empty-project"
  | "evaluation-prompt"
  | "sampling-unavailable";

/** Valid input conflicts with the current Project, Sample or Sampling state. */
export class RuntimeAdmissionConflictError extends Error {
  readonly retryable = false;

  constructor(readonly reason: RuntimeAdmissionConflictReason, message: string) {
    super(message);
    this.name = "RuntimeAdmissionConflictError";
  }
}
