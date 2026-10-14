/** A committed Run stop prevented a new SP stage mutation. */
export class RuntimeRunStoppedError extends Error {
  readonly retryable = false;

  constructor(readonly runId: string) {
    super(`Run ${runId} has been stopped`);
    this.name = "RuntimeRunStoppedError";
  }
}
