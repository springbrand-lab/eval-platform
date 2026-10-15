/**
 * Single source for Eval API content limits. Request body limits are derived from these values
 * rather than restated; validation and HTTP routing import the same constants.
 */
export const DATASET_DOCUMENT_BYTES = 10_000_000;
export const PROMPT_DATASET_FILE_BYTES = 10_000_000;
export const MATERIAL_FILE_BYTES = 5_000_000;
export const MATERIAL_TOTAL_BYTES = 20_000_000;
export const OUTPUT_SCHEMA_BYTES = 1_000_000;
/** Eval SP enforces these through `@springbrand/eval-harness`; they only size request bodies here. */
export const SP_MATERIAL_MAX_FILES = 500;
export const SP_SESSION_CONTENT_CHARS = 2_000_000;
/** Name, description, short identifiers and JSON framing around one request's content. */
export const METADATA_BODY_BYTES = 4_096;
export const JSON_BODY_BYTES = 1_000_000;
/** Client-chosen identifiers such as idempotency keys and Runtime entity IDs. */
export const IDENTIFIER_CHARS = 512;
export const EVALUATION_SAMPLING_IDS = 10_000;
export const SAMPLING_PAGE_SIZE_DEFAULT = 100;
export const SAMPLING_PAGE_SIZE_MAX = 1_000;

/** One JSON string escape (`\uXXXX`) is the most bytes a single text unit can occupy in a body. */
const JSON_ESCAPED_UNIT_BYTES = 6;
/** A quoted ID plus its separating comma inside a JSON array. */
const JSON_ARRAY_ITEM_FRAMING_BYTES = 3;

function jsonTextBodyBytes(contentUnits: number): number {
  return contentUnits * JSON_ESCAPED_UNIT_BYTES + METADATA_BODY_BYTES;
}

export const PROMPT_IMPORT_BODY_BYTES = jsonTextBodyBytes(PROMPT_DATASET_FILE_BYTES);
export const SESSION_BODY_BYTES = jsonTextBodyBytes(SP_SESSION_CONTENT_CHARS);
export const OUTPUT_SCHEMA_BODY_BYTES = jsonTextBodyBytes(OUTPUT_SCHEMA_BYTES);
/** Base64 files plus each file's path and media type. */
export const MATERIAL_BODY_BYTES = Math.ceil(MATERIAL_TOTAL_BYTES / 3) * 4
  + (SP_MATERIAL_MAX_FILES + 1) * METADATA_BODY_BYTES;
export const EVALUATION_BODY_BYTES = EVALUATION_SAMPLING_IDS
  * (IDENTIFIER_CHARS * JSON_ESCAPED_UNIT_BYTES + JSON_ARRAY_ITEM_FRAMING_BYTES)
  + jsonTextBodyBytes(2 * IDENTIFIER_CHARS);
