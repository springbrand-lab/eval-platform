import { HttpError, toHttpError, type HttpErrorCode } from "@eval-platform/eval-contracts/http-errors";
import {
  DataInUseError,
  DatasetEntityNotFoundError,
  DatasetIdentityConflictError,
  DatasetInputError,
} from "@eval-platform/eval-dataset";
import { MetricsEntityNotFoundError, MetricsQueryError } from "@eval-platform/eval-metrics";
import {
  RuntimeAdmissionConflictError,
  RuntimeEntityNotFoundError,
  RuntimeInputError,
  RuntimeProjectBusyError,
  RuntimeRecordConflictError,
  RuntimeRecordPersistenceError,
  RuntimeRunIdentityConflictError,
  RuntimeRunStoppedError,
  type RuntimeAdmissionConflictReason,
  type RuntimeEntity,
} from "@eval-platform/eval-runtime";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  AgentConfigFrozenError,
  BundleResourceInUseError,
  BundleResourceNotFoundError,
  CatalogInputError,
  CatalogPayloadTooLargeError,
  OutputSchemaNotFoundError,
  ProjectCreationKeyTakenError,
  ProjectEvaluationPlanLockedError,
  ProjectIdempotencyConflictError,
  ProjectRunStopConflictError,
  RunTargetsTooLargeError,
} from "../db/errors.js";
import { BundleFileError, type BundleFileErrorReason } from "../sp/bundle-errors.js";
import { EvalSpApiError, EvalSpTransportError } from "../sp/client.js";

const runtimeEntityCodes = {
  project: "PROJECT_NOT_FOUND",
  run: "RUN_NOT_FOUND",
  dataset: "DATASET_NOT_FOUND",
  "project-sample": "PROJECT_SAMPLE_NOT_FOUND",
  sampling: "SAMPLING_NOT_FOUND",
  evaluation: "EVALUATION_NOT_FOUND",
} as const satisfies Record<RuntimeEntity, HttpErrorCode>;

const admissionConflictCodes = {
  "source-branch": "PROJECT_SOURCE_BRANCH_CONFLICT",
  "evaluation-plan-required": "PROJECT_EVALUATION_PLAN_REQUIRED",
  "plan-changed": "PROJECT_PLAN_CHANGED",
  "stale-targets": "RUN_TARGETS_STALE",
  "empty-targets": "RUN_TARGETS_EMPTY",
  "creation-superseded": "RUN_IDEMPOTENCY_CONFLICT",
  "evaluation-prompt": "SAMPLE_EVALUATION_PROMPT_MISSING",
  "sampling-unavailable": "SAMPLING_UNAVAILABLE",
} as const satisfies Record<RuntimeAdmissionConflictReason, HttpErrorCode>;

const bundleFileCodes = {
  "not-found": "BUNDLE_FILE_NOT_FOUND",
  conflict: "BUNDLE_FILE_CONFLICT",
  "too-large": "BUNDLE_FILE_TOO_LARGE",
  invalid: "BUNDLE_FILE_INVALID",
  unavailable: "BUNDLE_FILE_UNAVAILABLE",
} as const satisfies Record<BundleFileErrorReason, HttpErrorCode>;

const metricsEntityCodes = {
  project: "PROJECT_NOT_FOUND",
  run: "RUN_NOT_FOUND",
  dataset: "DATASET_NOT_FOUND",
  "project-sample": "PROJECT_SAMPLE_NOT_FOUND",
  sampling: "SAMPLING_NOT_FOUND",
} as const satisfies Record<MetricsEntityNotFoundError["entity"], HttpErrorCode>;

const datasetEntityCodes = {
  dataset: "DATASET_NOT_FOUND",
  data: "DATA_NOT_FOUND",
} as const satisfies Record<DatasetEntityNotFoundError["entity"], HttpErrorCode>;

type ErrorClass = abstract new (...args: never[]) => Error;

/** Errors whose message is safe public text about the caller's own request. */
const publicMessageCodes = new Map<ErrorClass, HttpErrorCode>([
  [RuntimeProjectBusyError, "PROJECT_BUSY"],
  [RuntimeRunIdentityConflictError, "RUN_IDEMPOTENCY_CONFLICT"],
  [RuntimeRunStoppedError, "RUN_STOPPED"],
  [ProjectRunStopConflictError, "PROJECT_NO_ACTIVE_RUN"],
  [ProjectEvaluationPlanLockedError, "PROJECT_EVALUATION_PLAN_LOCKED"],
  [ProjectIdempotencyConflictError, "PROJECT_IDEMPOTENCY_CONFLICT"],
  [AgentConfigFrozenError, "AGENT_CONFIG_FROZEN"],
  [DatasetIdentityConflictError, "DATASET_IDENTITY_CONFLICT"],
  [DataInUseError, "DATA_IN_USE"],
  [CatalogPayloadTooLargeError, "CATALOG_PAYLOAD_TOO_LARGE"],
  [RunTargetsTooLargeError, "RUN_TARGETS_TOO_LARGE"],
  [BundleResourceNotFoundError, "BUNDLE_RESOURCE_NOT_FOUND"],
  [BundleResourceInUseError, "BUNDLE_RESOURCE_IN_USE"],
  [OutputSchemaNotFoundError, "OUTPUT_SCHEMA_NOT_FOUND"],
  [DatasetInputError, "DATASET_INPUT_INVALID"],
  [MetricsQueryError, "METRICS_QUERY_INVALID"],
]);

/** Errors that describe persisted Runtime facts; the response keeps the catalog text. */
const catalogMessageCodes = new Map<ErrorClass, HttpErrorCode>([
  [RuntimeRecordConflictError, "RUNTIME_RECORD_CONFLICT"],
  [ProjectCreationKeyTakenError, "RUNTIME_RECORD_CONFLICT"],
  [RuntimeRecordPersistenceError, "RUNTIME_PERSISTENCE_UNCONFIRMED"],
]);

const unavailableDatabaseCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "53300", "57P01", "57P02", "57P03", "08000", "08001", "08003", "08006"]);

/** SP's public error envelope; only its display text and field errors are relayed. */
const spErrorSchema = z.object({
  errMsg: z.string().min(1),
  errors: z.array(z.object({ path: z.string(), errMsg: z.string() })).optional(),
});

function fieldError(code: "RUNTIME_INPUT_INVALID" | "CATALOG_INPUT_INVALID", error: RuntimeInputError | CatalogInputError): HttpError {
  return new HttpError(code, error.message, {
    cause: error,
    ...(error.field === undefined ? {} : { errors: [{ path: error.field, errMsg: error.message }] }),
  });
}

function evalSpError(error: EvalSpApiError): HttpError {
  const upstream = { cause: error, upstreamStatus: error.status };
  if (error.status === 401) return new HttpError("AUTH_UNAUTHENTICATED", "Eval SP session is invalid", upstream);
  if (error.status === 403) return new HttpError("EVAL_SP_FORBIDDEN", undefined, upstream);
  if (error.status === 404) return new HttpError("EVAL_SP_NOT_FOUND", undefined, upstream);
  if (error.status === 429) return new HttpError("REQUEST_RATE_LIMITED", undefined, upstream);
  if (error.status === 400 || error.status === 409 || error.status === 422) {
    const relayed = spErrorSchema.safeParse(error.payload);
    const code = error.status === 409 ? "EVAL_SP_CONFLICT" : "EVAL_SP_REQUEST_INVALID";
    return relayed.success
      ? new HttpError(code, relayed.data.errMsg, { ...upstream, ...(relayed.data.errors ? { errors: relayed.data.errors } : {}) })
      : new HttpError(code, undefined, upstream);
  }
  return new HttpError("EVAL_SP_REQUEST_FAILED", undefined, upstream);
}

function isDatabaseUnavailable(error: Error): boolean {
  if (!("query" in error)) return false;
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++, cause = cause.cause) {
    if ("code" in cause && unavailableDatabaseCodes.has(String(cause.code))) return true;
  }
  return false;
}

export { errorDiagnostics } from "@springbrand/http/server";

/** Translate one thrown error into the public catalog by its class; unknown errors stay internal. */
export function apiError(error: Error): HttpError {
  const http = toHttpError(error);
  if (http) return http;
  // A failure followed by a failed compensation answers as the failure and logs both.
  if (error instanceof AggregateError && error.errors[0] instanceof Error) {
    const primary = apiError(error.errors[0]);
    return new HttpError(primary.code, primary.message, {
      cause: error, ...(primary.errors === undefined ? {} : { errors: primary.errors }),
    });
  }
  if (error instanceof RuntimeEntityNotFoundError) return new HttpError(runtimeEntityCodes[error.entity], error.message, { cause: error });
  if (error instanceof RuntimeAdmissionConflictError) return new HttpError(admissionConflictCodes[error.reason], error.message, { cause: error });
  if (error instanceof RuntimeInputError) return fieldError("RUNTIME_INPUT_INVALID", error);
  if (error instanceof CatalogInputError) return fieldError("CATALOG_INPUT_INVALID", error);
  if (error instanceof DatasetEntityNotFoundError) return new HttpError(datasetEntityCodes[error.entity], error.message, { cause: error });
  if (error instanceof MetricsEntityNotFoundError) return new HttpError(metricsEntityCodes[error.entity], error.message, { cause: error });
  if (error instanceof BundleFileError) return new HttpError(bundleFileCodes[error.reason], error.message, { cause: error });
  if (error instanceof EvalSpApiError) return evalSpError(error);
  if (error instanceof EvalSpTransportError) return new HttpError("EVAL_SP_UNAVAILABLE", undefined, { cause: error });
  for (const [type, code] of publicMessageCodes) {
    if (error instanceof type) return new HttpError(code, error.message, { cause: error });
  }
  for (const [type, code] of catalogMessageCodes) {
    if (error instanceof type) return new HttpError(code, undefined, { cause: error });
  }
  if (error instanceof HTTPException && error.status === 400) return new HttpError("REQUEST_INVALID_JSON", undefined, { cause: error });
  if (isDatabaseUnavailable(error)) return new HttpError("DATABASE_UNAVAILABLE", undefined, { cause: error });
  return new HttpError("INTERNAL_ERROR", undefined, { cause: error });
}
