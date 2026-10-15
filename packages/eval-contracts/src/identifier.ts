import { z } from "zod";

export const IDENTIFIER_RULE = "must be a non-empty identifier without surrounding whitespace";

/** An opaque identifier: a non-empty string without surrounding whitespace. */
export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

export const identifierSchema = z.string().refine(isIdentifier, `Identifier ${IDENTIFIER_RULE}`);
