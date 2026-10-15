import type { EvaluationOutputSchema } from "@eval-platform/eval-contracts";
import { parseStrictJson } from "@eval-platform/eval-dataset";
import Ajv2020 from "ajv/dist/2020.js";
import { CatalogInputError, CatalogPayloadTooLargeError } from "./db/errors.js";
import { OUTPUT_SCHEMA_BYTES } from "./limits.js";

/** A material-relative path; SP writes it below the returned materialization root. */
export const EVALUATION_OUTPUT_SCHEMA_MATERIAL_PATH = "/evaluation-output.schema.json";
const schemaValidator = new Ajv2020({ strict: false, allErrors: true });

/** Parse one uploaded JSON Schema file into a bounded JSON object whose numbers round-trip exactly. */
export function parseEvaluationOutputSchema(content: string): EvaluationOutputSchema {
  if (Buffer.byteLength(content, "utf8") > OUTPUT_SCHEMA_BYTES) {
    throw new CatalogPayloadTooLargeError("Evaluation output JSON Schema is too large");
  }
  let schema: unknown;
  try {
    schema = parseStrictJson(content);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new CatalogInputError(error.message, "content");
  }
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new CatalogInputError("Evaluation output JSON Schema must be an object", "content");
  }
  if (!hasOnlySafeNumbers(schema)) {
    throw new CatalogInputError("Evaluation output JSON Schema must contain only finite, safe JSON numbers", "content");
  }
  if (!schemaValidator.validateSchema(schema)) {
    throw new CatalogInputError(`Evaluation output JSON Schema is invalid: ${schemaValidator.errorsText()}`, "content");
  }
  return schema as EvaluationOutputSchema;
}

function hasOnlySafeNumbers(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (value === null || typeof value !== "object") return true;
  return Object.values(value).every(hasOnlySafeNumbers);
}
