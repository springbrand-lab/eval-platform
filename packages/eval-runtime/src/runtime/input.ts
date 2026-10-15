import { IDENTIFIER_RULE, isIdentifier } from "@eval-platform/eval-contracts";
import { RuntimeInputError } from "./errors.js";

export function requireIdentifier(value: unknown, field: string): asserts value is string {
  if (!isIdentifier(value)) throw new RuntimeInputError(`${field} ${IDENTIFIER_RULE}`, field);
}

export function requireDistinctIds(ids: readonly string[], field: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new RuntimeInputError(`${field} must not contain duplicate ids`, field);
  }
}
