import { z } from "@hono/zod-openapi";
import { httpErrorSchema, validationErrorSchema } from "@eval-platform/eval-contracts/http-errors";
import { jsonContent } from "stoker/openapi/helpers";
import { IDENTIFIER_CHARS } from "../limits.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/** Client-chosen text keys: bounded, without surrounding whitespace or control characters. */
export const idempotencyKeySchema = z.string().min(1).max(IDENTIFIER_CHARS)
  .refine((value) => value === value.trim(), "must not have surrounding whitespace")
  .refine((value) => !CONTROL_CHARACTERS.test(value), "must not contain control characters");

/** Runtime entity IDs (Project, Run, Sample, Sampling, Evaluation, Config) are opaque path-safe text. */
export const entityIdSchema = idempotencyKeySchema.refine((value) => !value.includes("/"), "must not contain '/'");

/** Bundle, Material, Session and output-format names and descriptions. */
export const catalogLabelSchema = z.string().trim().min(1);

export const catalogMetadataPatchSchema = z.strictObject({
  name: catalogLabelSchema.exactOptional(),
  description: catalogLabelSchema.exactOptional(),
}).refine((patch) => Object.keys(patch).length > 0, "Specify name or description");

export function jsonBodyContent<T extends z.ZodType>(schema: T) {
  return { required: true, content: { "application/json": { schema } } } as const;
}

export const errorResponses = {
  401: jsonContent(httpErrorSchema, "Eval SP session is missing or invalid"),
  403: jsonContent(httpErrorSchema, "Origin or Eval SP access is denied"),
  422: jsonContent(validationErrorSchema, "Validation error"),
  500: jsonContent(httpErrorSchema, "Internal error"),
  503: jsonContent(httpErrorSchema, "A dependency is unavailable"),
} as const;

export const bodyErrorResponses = {
  ...errorResponses,
  400: jsonContent(httpErrorSchema, "Invalid JSON or input"),
  413: jsonContent(httpErrorSchema, "Request body is too large"),
  415: jsonContent(httpErrorSchema, "Unsupported Content-Type"),
} as const;

export const notFoundResponse = { 404: jsonContent(httpErrorSchema, "Not found") } as const;
export const conflictResponse = { 409: jsonContent(httpErrorSchema, "Conflicts with current state") } as const;
export const deletedResponse = { 204: { description: "Deleted" } } as const;
