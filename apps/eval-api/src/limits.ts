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
/** Most error details one Bundle content validation or ZIP import reports. */
export const BUNDLE_ERROR_DETAILS = 100;
/** One Bundle ZIP import. */
export const ZIP_ARCHIVE_BYTES = 50_000_000;
/** Declared decompressed bytes of one archive; SP's strict-ZIP inspector verifies each against the inflated size. */
export const ZIP_EXPANDED_BYTES = 100_000_000;
export const ZIP_ENTRIES = 5_000;
export const ZIP_PATH_CHARS = 768;
export const ZIP_RESOURCES = 500;
/** Name, description, short identifiers and JSON framing around one request's content. */
export const METADATA_BODY_BYTES = 4_096;
export const JSON_BODY_BYTES = 1_000_000;
/** Client-chosen identifiers such as idempotency keys and Runtime entity IDs. */
export const IDENTIFIER_CHARS = 512;
/** Most Data a Project binds and most target IDs one Run selector or target list may carry. */
export const RUN_TARGET_IDS = 10_000;
/** Most Samplings one ProjectSample creates per execution. */
export const SAMPLING_COUNT_MAX = 100;

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
/** One multipart archive plus its boundaries, part headers and metadata fields. */
export const ZIP_BODY_BYTES = ZIP_ARCHIVE_BYTES + METADATA_BODY_BYTES;
const UUID_CHARS = 36;
/** Room for one escaped ID array item, or for one `"<uuid>":<count>` sampling-count entry. */
const ID_ITEM_BYTES = IDENTIFIER_CHARS * JSON_ESCAPED_UNIT_BYTES + JSON_ARRAY_ITEM_FRAMING_BYTES;
const UUID_ENTRY_BYTES = UUID_CHARS * JSON_ESCAPED_UNIT_BYTES + JSON_ARRAY_ITEM_FRAMING_BYTES + 8;
/** A selector carries at most RUN_TARGET_IDS IDs. */
export const RUN_PREVIEW_BODY_BYTES = RUN_TARGET_IDS * ID_ITEM_BYTES + jsonTextBodyBytes(IDENTIFIER_CHARS);
/** A selector plus its fixed targets. */
export const RUN_BODY_BYTES = 2 * RUN_TARGET_IDS * ID_ITEM_BYTES + jsonTextBodyBytes(2 * IDENTIFIER_CHARS);
/** Selected Data IDs and per-Data sampling counts, plus names, descriptions and both plans. */
export const PROJECT_BODY_BYTES = 2 * RUN_TARGET_IDS * UUID_ENTRY_BYTES + JSON_BODY_BYTES;

/** An expanded Run selection exceeds one admission request. */
export class RunTargetsTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Select at most ${limit} target IDs per Run`);
    this.name = "RunTargetsTooLargeError";
  }
}

/** The single check of RUN_TARGET_IDS for a Project's bound Data and an expanded Run selection. */
export function requireRunTargetCount(count: number): void {
  if (count > RUN_TARGET_IDS) throw new RunTargetsTooLargeError(RUN_TARGET_IDS);
}
