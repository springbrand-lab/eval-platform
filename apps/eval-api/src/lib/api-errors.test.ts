import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { DataInUseError, DatasetEntityNotFoundError, DatasetIdentityConflictError, DatasetInputError } from "@eval-platform/eval-dataset";
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
} from "@eval-platform/eval-runtime";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
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
import { BundleFileError } from "../sp/bundle-errors.js";
import { EvalSpApiError, EvalSpTransportError } from "../sp/client.js";
import { apiError, errorDiagnostics } from "./api-errors.js";

const id = "00000000-0000-4000-8000-000000000001";

describe("apiError", () => {
  it.each([
    [new RuntimeEntityNotFoundError("project", "p"), 404, "PROJECT_NOT_FOUND"],
    [new RuntimeEntityNotFoundError("run", "r"), 404, "RUN_NOT_FOUND"],
    [new RuntimeEntityNotFoundError("dataset", id), 404, "DATASET_NOT_FOUND"],
    [new RuntimeEntityNotFoundError("project-sample", "s"), 404, "PROJECT_SAMPLE_NOT_FOUND"],
    [new RuntimeEntityNotFoundError("sampling", "s"), 404, "SAMPLING_NOT_FOUND"],
    [new RuntimeEntityNotFoundError("evaluation", "e"), 404, "EVALUATION_NOT_FOUND"],
    [new RuntimeAdmissionConflictError("source-branch", "m"), 409, "PROJECT_SOURCE_BRANCH_CONFLICT"],
    [new RuntimeAdmissionConflictError("evaluation-plan-required", "m"), 409, "PROJECT_EVALUATION_PLAN_REQUIRED"],
    [new RuntimeAdmissionConflictError("plan-changed", "m"), 409, "PROJECT_PLAN_CHANGED"],
    [new RuntimeAdmissionConflictError("stale-targets", "m"), 409, "RUN_TARGETS_STALE"],
    [new RuntimeAdmissionConflictError("empty-targets", "m"), 409, "RUN_TARGETS_EMPTY"],
    [new RuntimeAdmissionConflictError("creation-superseded", "m"), 409, "RUN_IDEMPOTENCY_CONFLICT"],
    [new ProjectCreationKeyTakenError(), 409, "RUNTIME_RECORD_CONFLICT"],
    [new RuntimeAdmissionConflictError("evaluation-prompt", "m"), 409, "SAMPLE_EVALUATION_PROMPT_MISSING"],
    [new RuntimeAdmissionConflictError("sampling-unavailable", "m"), 409, "SAMPLING_UNAVAILABLE"],
    [new RuntimeProjectBusyError("p", "r"), 409, "PROJECT_BUSY"],
    [new RuntimeRunIdentityConflictError("m"), 409, "RUN_IDEMPOTENCY_CONFLICT"],
    [new RuntimeRunStoppedError("r"), 409, "RUN_STOPPED"],
    [new ProjectRunStopConflictError(), 409, "PROJECT_NO_ACTIVE_RUN"],
    [new ProjectEvaluationPlanLockedError("p"), 409, "PROJECT_EVALUATION_PLAN_LOCKED"],
    [new ProjectIdempotencyConflictError(), 409, "PROJECT_IDEMPOTENCY_CONFLICT"],
    [new AgentConfigFrozenError(id), 409, "AGENT_CONFIG_FROZEN"],
    [new DatasetEntityNotFoundError("dataset", id), 404, "DATASET_NOT_FOUND"],
    [new DatasetEntityNotFoundError("data", id), 404, "DATA_NOT_FOUND"],
    [new DatasetInputError("m"), 400, "DATASET_INPUT_INVALID"],
    [new DatasetIdentityConflictError("data", id), 409, "DATASET_IDENTITY_CONFLICT"],
    [new DataInUseError(id), 409, "DATA_IN_USE"],
    [new CatalogPayloadTooLargeError("m"), 413, "CATALOG_PAYLOAD_TOO_LARGE"],
    [new RunTargetsTooLargeError(10_000), 413, "RUN_TARGETS_TOO_LARGE"],
    [new BundleResourceNotFoundError("Material", id), 404, "BUNDLE_RESOURCE_NOT_FOUND"],
    [new BundleResourceInUseError("Session", id), 409, "BUNDLE_RESOURCE_IN_USE"],
    [new OutputSchemaNotFoundError(id), 404, "OUTPUT_SCHEMA_NOT_FOUND"],
    [new MetricsQueryError("m"), 400, "METRICS_QUERY_INVALID"],
    [new MetricsEntityNotFoundError("dataset", id), 404, "DATASET_NOT_FOUND"],
    [new MetricsEntityNotFoundError("project-sample", "s"), 404, "PROJECT_SAMPLE_NOT_FOUND"],
    [new MetricsEntityNotFoundError("sampling", "s"), 404, "SAMPLING_NOT_FOUND"],
    [new BundleFileError("not-found", "m"), 404, "BUNDLE_FILE_NOT_FOUND"],
    [new BundleFileError("conflict", "m"), 409, "BUNDLE_FILE_CONFLICT"],
    [new BundleFileError("too-large", "m"), 413, "BUNDLE_FILE_TOO_LARGE"],
    [new BundleFileError("invalid", "m"), 400, "BUNDLE_FILE_INVALID"],
    [new BundleFileError("unavailable", "m"), 503, "BUNDLE_FILE_UNAVAILABLE"],
    [new EvalSpApiError(401, null), 401, "AUTH_UNAUTHENTICATED"],
    [new EvalSpApiError(403, null), 403, "EVAL_SP_FORBIDDEN"],
    [new EvalSpApiError(404, null), 404, "EVAL_SP_NOT_FOUND"],
    [new EvalSpApiError(409, null), 409, "EVAL_SP_CONFLICT"],
    [new EvalSpApiError(429, null), 429, "REQUEST_RATE_LIMITED"],
    [new EvalSpApiError(500, null), 502, "EVAL_SP_REQUEST_FAILED"],
    [new EvalSpTransportError(new Error("offline")), 503, "EVAL_SP_UNAVAILABLE"],
  ] as const)("maps %o by class to %i %s", (error, status, code) => {
    const translated = apiError(error);
    expect({ status: translated.status, code: translated.code }).toEqual({ status, code });
    expect(translated.cause).toBe(error);
  });

  it("reports field errors for typed input failures", () => {
    expect(apiError(new RuntimeInputError("samplingCount must be a positive integer", "samplingCount"))).toMatchObject({
      code: "RUNTIME_INPUT_INVALID", errors: [{ path: "samplingCount", errMsg: "samplingCount must be a positive integer" }],
    });
    expect(apiError(new CatalogInputError("name must be a nonblank string", "name"))).toMatchObject({
      code: "CATALOG_INPUT_INVALID", errors: [{ path: "name", errMsg: "name must be a nonblank string" }],
    });
  });

  it("relays SP validation text but never persisted Runtime facts", () => {
    expect(apiError(new EvalSpApiError(400, {
      code: "AGENT_CONFIG_INVALID", errMsg: "Agent configuration is invalid", errors: [{ path: "name", errMsg: "Required" }],
    }))).toMatchObject({ code: "EVAL_SP_REQUEST_INVALID", message: "Agent configuration is invalid", errors: [{ path: "name" }] });
    expect(apiError(new RuntimeRecordConflictError("stored facts: private"))).toMatchObject({
      code: "RUNTIME_RECORD_CONFLICT", message: "Run records changed concurrently. Refresh and try again",
    });
    expect(apiError(new RuntimeRecordPersistenceError("private", "unknown", null, {}, {})).code)
      .toBe("RUNTIME_PERSISTENCE_UNCONFIRMED");
  });

  it("answers a failure followed by a failed compensation as the failure and keeps both for diagnostics", () => {
    const failure = new RuntimeProjectBusyError("p", "r");
    const aggregate = new AggregateError([failure, new Error("database unavailable")], "compensation failed");
    expect(apiError(aggregate)).toMatchObject({ code: "PROJECT_BUSY", status: 409, cause: aggregate });
  });

  it("passes catalog errors through and keeps unknown failures internal with their cause", () => {
    const http = new HttpError("RUN_NOT_FOUND");
    expect(apiError(http)).toBe(http);
    const unknown = new TypeError("Unknown run run-1 password=secret");
    expect(apiError(unknown)).toMatchObject({ code: "INTERNAL_ERROR", status: 500, message: "Internal server error", cause: unknown });
  });

  it("recognizes an unavailable database without exposing SQL or parameters", () => {
    const error = new DrizzleQueryError("select private_column", ["private-value"],
      Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }));
    const translated = apiError(error);
    expect(translated.code).toBe("DATABASE_UNAVAILABLE");
    const log = JSON.stringify(errorDiagnostics(translated));
    expect(log).toContain("ECONNREFUSED");
    expect(log).not.toContain("private");
    expect(apiError(new DrizzleQueryError("select 1", [], Object.assign(new Error("duplicate"), { code: "23505" }))).code)
      .toBe("INTERNAL_ERROR");
  });
});
