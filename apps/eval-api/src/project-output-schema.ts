import type { EvaluationOutputSchema } from "@eval-platform/eval-contracts";
import Ajv2020 from "ajv/dist/2020.js";

/** A material-relative path; SP writes it below the returned materialization root. */
export const EVALUATION_OUTPUT_SCHEMA_MATERIAL_PATH = "/evaluation-output.schema.json";
export const MAX_EVALUATION_OUTPUT_SCHEMA_BYTES = 1_000_000;
const schemaValidator = new Ajv2020({ strict: false, allErrors: true });

/** Keep the bound Schema a plain, bounded JSON object with stable serialized bytes. */
export function parseEvaluationOutputSchema(value: unknown): EvaluationOutputSchema {
  if (!isPlainObject(value)) throw new TypeError("Evaluation output JSON Schema must be an object");
  let encoded: string;
  try {
    encoded = JSON.stringify(value, function (this: Record<string, unknown>, key, item: unknown) {
      const original = this[key];
      if (!Object.is(original, item)) throw new TypeError("JSON Schema must not use toJSON");
      if (original === null || typeof original === "string" || typeof original === "boolean") return original;
      if (typeof original === "number" && Number.isFinite(original)
        && (!Number.isInteger(original) || Number.isSafeInteger(original))) return original;
      if (Array.isArray(original) || isPlainObject(original)) return original;
      throw new TypeError("Evaluation output JSON Schema must contain only JSON values");
    });
  } catch {
    throw new TypeError("Evaluation output JSON Schema must contain only finite, safe JSON values");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_EVALUATION_OUTPUT_SCHEMA_BYTES) {
    throw new RangeError("Evaluation output JSON Schema is too large");
  }
  const schema = JSON.parse(encoded) as EvaluationOutputSchema;
  if (!schemaValidator.validateSchema(schema)) {
    throw new TypeError(`Evaluation output JSON Schema is invalid: ${schemaValidator.errorsText()}`);
  }
  return schema;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
