export type RuntimeEntity =
  | "project"
  | "run"
  | "dataset"
  | "project-sample"
  | "sampling"
  | "evaluation";

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
  /** pipeline/evaluation on a Project without an evaluation plan. */
  | "evaluation-plan-required"
  /** The plan digest changed between preview/read and the admission transaction. */
  | "plan-changed"
  /** Submitted targets no longer match the Project's current Samplings. */
  | "stale-targets"
  /** A creation replay's first Run arrived after the Project already ran under another key. */
  | "creation-superseded"
  | "empty-targets"
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

/** A matching idempotency key is bound to different Run facts. */
export class RuntimeRunIdentityConflictError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeRunIdentityConflictError";
  }
}

/** A new Run key was rejected because its Project still has an unfinished Run. */
export class RuntimeProjectBusyError extends Error {
  readonly retryable = false;

  constructor(readonly projectId: string, readonly activeRunId: string) {
    super(`Project ${projectId} already has unfinished Run ${activeRunId}`);
    this.name = "RuntimeProjectBusyError";
  }
}

/** A committed Run stop prevented a new SP stage mutation. */
export class RuntimeRunStoppedError extends Error {
  readonly retryable = false;

  constructor(readonly runId: string) {
    super(`Run ${runId} has been stopped`);
    this.name = "RuntimeRunStoppedError";
  }
}

/** A conditional Store write found different persisted facts. */
export class RuntimeRecordConflictError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeRecordConflictError";
  }
}

export type RuntimePersistenceOutcome = "unknown" | "not-committed" | "conflict";

/** The requested facts were not confirmed after the persistence retry budget. */
export class RuntimeRecordPersistenceError extends Error {
  readonly retryable = false;
  #attemptedRecord: unknown;
  #expectedRecord: unknown;

  constructor(
    message: string,
    readonly outcome: RuntimePersistenceOutcome,
    readonly cause: unknown,
    attemptedRecord: unknown,
    expectedRecord: unknown,
  ) {
    super(message);
    this.name = "RuntimeRecordPersistenceError";
    this.#attemptedRecord = attemptedRecord;
    this.#expectedRecord = expectedRecord;
  }

  get attemptedRecord(): unknown {
    return this.#attemptedRecord;
  }

  get expectedRecord(): unknown {
    return this.#expectedRecord;
  }
}
