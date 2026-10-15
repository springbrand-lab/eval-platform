import { RuntimeInputError } from "./errors.js";

export function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RuntimeInputError(`${field} is required`, field);
  }
}

export function requireDistinctIds(ids: readonly string[], field: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new RuntimeInputError(`${field} must not contain duplicate ids`, field);
  }
}
