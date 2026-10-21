import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { EvalSpApiError } from "../sp/http.js";

export class ImportConflictError extends HttpError {
  constructor(message: string, cause?: unknown) { super("EVAL_SP_CONFLICT", message, cause === undefined ? {} : { cause }); }
}
export class ImportDependencyError extends HttpError {
  constructor(message = "Agent import dependency is unavailable", cause?: unknown) {
    super("EVAL_SP_UNAVAILABLE", message, cause === undefined ? {} : { cause });
  }
}
/** A known negative capability probe, not an ambiguous remote write or browser authentication failure. */
export class ImportTargetDisabledError extends ImportDependencyError {
  constructor() { super("Target Agent imports are disabled for the fixed Eval service account"); }
}
export class ImportOutcomeUnknownError extends HttpError {
  constructor(cause?: unknown) {
    super("EVAL_SP_UNAVAILABLE", "Import result is awaiting a verified target receipt; retry this task with the same key", { cause });
  }
}
export class ImportLeaseLostError extends Error {
  constructor() { super("Import task lease was lost"); }
}
export function importConflict(error: unknown): boolean {
  if (error instanceof ImportConflictError) return true;
  if (!(error instanceof EvalSpApiError) || error.status !== 409
    || error.payload === null || typeof error.payload !== "object" || !("code" in error.payload)) return false;
  return error.payload.code === "AGENT_CONFIG_IMPORT_CONFLICT" || error.payload.code === "REQUEST_CONFLICT";
}
/** Never relay upstream authentication/404 as a browser login or task-not-found failure. */
export function dependencyFailure(cause: unknown): never {
  throw new ImportDependencyError(undefined, cause);
}
