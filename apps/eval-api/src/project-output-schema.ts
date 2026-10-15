import type { EvaluationOutputSchema } from "@eval-platform/eval-contracts";
import Ajv2020 from "ajv/dist/2020.js";
import { CatalogInputError, CatalogPayloadTooLargeError } from "./db/errors.js";
import { OUTPUT_SCHEMA_BYTES } from "./limits.js";

/** A material-relative path; SP writes it below the returned materialization root. */
export const EVALUATION_OUTPUT_SCHEMA_MATERIAL_PATH = "/evaluation-output.schema.json";
export const MAX_EVALUATION_OUTPUT_SCHEMA_BYTES = OUTPUT_SCHEMA_BYTES;
const schemaValidator = new Ajv2020({ strict: false, allErrors: true });

class NonJsonValueError extends Error {}

/** Keep the bound Schema a plain, bounded JSON object with stable serialized bytes. */
export function parseEvaluationOutputSchema(value: unknown): EvaluationOutputSchema {
  if (!isPlainObject(value)) throw new CatalogInputError("Evaluation output JSON Schema must be an object", "content");
  let encoded: string;
  try {
    encoded = JSON.stringify(value, function (this: Record<string, unknown>, key, item: unknown) {
      const original = this[key];
      if (!Object.is(original, item)) throw new NonJsonValueError();
      if (original === null || typeof original === "string" || typeof original === "boolean") return original;
      if (typeof original === "number" && Number.isFinite(original)
        && (!Number.isInteger(original) || Number.isSafeInteger(original))) return original;
      if (Array.isArray(original) || isPlainObject(original)) return original;
      throw new NonJsonValueError();
    });
  } catch (error) {
    if (!(error instanceof NonJsonValueError)) throw error;
    throw new CatalogInputError("Evaluation output JSON Schema must contain only finite, safe JSON values", "content");
  }
  if (Buffer.byteLength(encoded, "utf8") > OUTPUT_SCHEMA_BYTES) {
    throw new CatalogPayloadTooLargeError("Evaluation output JSON Schema is too large");
  }
  const schema = JSON.parse(encoded) as EvaluationOutputSchema;
  if (!schemaValidator.validateSchema(schema)) {
    throw new CatalogInputError(`Evaluation output JSON Schema is invalid: ${schemaValidator.errorsText()}`, "content");
  }
  return schema;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
