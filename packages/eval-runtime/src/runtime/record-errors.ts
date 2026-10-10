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
