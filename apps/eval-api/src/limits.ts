/**
 * Single source for Eval API content limits. Request body limits are derived from these values
 * rather than restated; validation and HTTP routing import the same constants.
 */
export const DATASET_DOCUMENT_BYTES = 10_000_000;
export const PROMPT_DATASET_FILE_BYTES = 10_000_000;
export const MATERIAL_FILE_BYTES = 5_000_000;
export const MATERIAL_TOTAL_BYTES = 20_000_000;
export const OUTPUT_SCHEMA_BYTES = 1_000_000;
export const METADATA_BODY_BYTES = 4_096;
export const JSON_BODY_BYTES = 1_000_000;

/** One all-selection response must fit the corresponding explicit evaluation POST. */
export const EVALUATION_SAMPLING_IDS = 10_000;
export const EVALUATION_BODY_BYTES = 8 * 1024 * 1024;
/** Reserves space for the two 512-character request fields and JSON framing. */
export const EVALUATION_SELECTION_RESPONSE_BYTES = EVALUATION_BODY_BYTES - 8 * 1024;
