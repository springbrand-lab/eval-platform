import { defineErrorCatalog } from "@springbrand/http/catalog";

/** The only Eval API error-code catalog; status codes and default public messages live here. */
const errorDefinitions = {
  REQUEST_INVALID_INPUT: { status: 400, message: "Request input is invalid" },
  REQUEST_INVALID_JSON: { status: 400, message: "Expected a JSON object with unique fields" },
  REQUEST_VALIDATION_FAILED: { status: 422, message: "Validation failed" },
  REQUEST_PAYLOAD_TOO_LARGE: { status: 413, message: "Request body is too large" },
  REQUEST_UNSUPPORTED_MEDIA_TYPE: { status: 415, message: "Content-Type is not supported" },
  REQUEST_UNTRUSTED_ORIGIN: { status: 403, message: "Request origin is not allowed" },
  REQUEST_NOT_FOUND: { status: 404, message: "Resource not found" },
  REQUEST_RATE_LIMITED: { status: 429, message: "Too many requests" },
  AUTH_UNAUTHENTICATED: { status: 401, message: "An Eval SP Bearer session is required" },
  INTERNAL_ERROR: { status: 500, message: "Internal server error" },
  DATABASE_UNAVAILABLE: { status: 503, message: "The service is temporarily unavailable. Try again shortly" },
  RESPONSE_INVALID: { status: 502, message: "The server returned an invalid response" },

  EVAL_SP_FORBIDDEN: { status: 403, message: "Eval SP denied the request" },
  EVAL_SP_NOT_FOUND: { status: 404, message: "Eval SP resource not found" },
  EVAL_SP_CONFLICT: { status: 409, message: "Eval SP resource conflicts with existing state" },
  EVAL_SP_REQUEST_INVALID: { status: 422, message: "Eval SP rejected the request" },
  EVAL_SP_REQUEST_FAILED: { status: 502, message: "Eval SP request failed" },
  EVAL_SP_UNAVAILABLE: { status: 503, message: "Eval SP is unavailable. Try again shortly" },

  AGENT_CONFIG_FROZEN: { status: 409, message: "Agent Config is a frozen Project copy and cannot be changed" },

  PROJECT_NOT_FOUND: { status: 404, message: "Project not found" },
  PROJECT_BUSY: { status: 409, message: "Project already has an unfinished Run" },
  PROJECT_IDEMPOTENCY_CONFLICT: { status: 409, message: "Idempotency key was used to create a different Project" },
  PROJECT_NO_ACTIVE_RUN: { status: 409, message: "Project has no unfinished Run" },
  PROJECT_SOURCE_BRANCH_CONFLICT: { status: 409, message: "Project belongs to a different SP source branch" },
  PROJECT_EVALUATION_PLAN_REQUIRED: { status: 409, message: "Project needs an evaluation plan before evaluating" },
  PROJECT_EVALUATION_PLAN_LOCKED: { status: 409, message: "Project evaluation plan is locked by an evaluating Run" },
  PROJECT_PLAN_CHANGED: { status: 409, message: "Project plan changed. Preview the Run again" },
  PROJECT_SAMPLE_NOT_FOUND: { status: 404, message: "Project Sample not found" },
  RUN_NOT_FOUND: { status: 404, message: "Run not found" },
  RUN_IDEMPOTENCY_CONFLICT: { status: 409, message: "Idempotency key was used for a different Run" },
  RUN_STOPPED: { status: 409, message: "Run has been stopped" },
  RUN_TARGETS_STALE: { status: 409, message: "Run targets changed. Preview the Run again" },
  RUN_TARGETS_EMPTY: { status: 409, message: "Run selection contains no targets" },
  RUN_TARGETS_TOO_LARGE: { status: 413, message: "Run selection exceeds one request" },
  RUNTIME_INPUT_INVALID: { status: 400, message: "Run or configuration input is invalid" },
  RUNTIME_RECORD_CONFLICT: { status: 409, message: "Run records changed concurrently. Refresh and try again" },
  RUNTIME_PERSISTENCE_UNCONFIRMED: { status: 503, message: "Run records could not be confirmed. Retry with the same idempotency key" },
  PROJECT_SAMPLE_EVALUATION_PROMPT_MISSING: { status: 409, message: "Selected ProjectSamples need an evaluation prompt" },
  SAMPLING_NOT_FOUND: { status: 404, message: "Sampling not found" },
  SAMPLING_UNAVAILABLE: { status: 409, message: "Selected Sampling is unavailable for evaluation" },
  EVALUATION_NOT_FOUND: { status: 404, message: "Evaluation not found" },

  DATASET_NOT_FOUND: { status: 404, message: "Dataset not found" },
  DATASET_INPUT_INVALID: { status: 400, message: "Dataset input is invalid" },
  DATASET_IDENTITY_CONFLICT: { status: 409, message: "Dataset or Data identity conflicts with existing records" },
  DATA_NOT_FOUND: { status: 404, message: "Data not found" },
  DATA_IN_USE: { status: 409, message: "Data is still referenced" },

  CATALOG_INPUT_INVALID: { status: 400, message: "Catalog input is invalid" },
  CATALOG_PAYLOAD_TOO_LARGE: { status: 413, message: "Catalog content is too large" },
  BUNDLE_RESOURCE_NOT_FOUND: { status: 404, message: "Bundle resource not found" },
  BUNDLE_RESOURCE_IN_USE: { status: 409, message: "Bundle resource is still bound to Data" },
  BUNDLE_FILE_NOT_FOUND: { status: 404, message: "Bundle file not found" },
  BUNDLE_FILE_TOO_LARGE: { status: 413, message: "Bundle file is too large" },
  BUNDLE_FILE_INVALID: { status: 400, message: "Bundle file is invalid" },
  BUNDLE_FILE_UNAVAILABLE: { status: 503, message: "Bundle file could not be read. Try again shortly" },
  OUTPUT_SCHEMA_NOT_FOUND: { status: 404, message: "Output format not found" },

  METRICS_QUERY_INVALID: { status: 400, message: "Metrics query is invalid" },

  // Only the browser client produces these (status 0); they never appear in server responses.
  NETWORK_ERROR: { status: 0, message: "Unable to reach the server" },
  REQUEST_TIMEOUT: { status: 0, message: "The request timed out. Try again shortly" },
  RESPONSE_TOO_LARGE: { status: 0, message: "The response is too large to load" },
  RUNTIME_UNSUPPORTED: { status: 0, message: "This browser cannot send the request" },
  REQUEST_REDIRECT_BLOCKED: { status: 0, message: "The server redirected the request unexpectedly" },
  HTTP_ERROR: { status: 0, message: "The request could not be completed. Check and try again" },
} as const;

export const errorCatalog = defineErrorCatalog(errorDefinitions);

export const {
  HttpError,
  toHttpError,
  httpErrorSchema,
  validationErrorSchema,
  decodeError,
} = errorCatalog;
export type HttpError = InstanceType<typeof HttpError>;

/** Codes that can appear in an HTTP response; status-0 codes belong to the client only. */
export type HttpErrorCode = (typeof errorCatalog.codes)[number];
