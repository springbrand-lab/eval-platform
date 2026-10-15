import { createRoute, z } from "@hono/zod-openapi";
import type { EvaluationRecord, RunHandle, RunSnapshot } from "@eval-platform/eval-contracts";
import { httpErrorSchema } from "@eval-platform/eval-contracts/http-errors";
import type { SamplingSnapshot } from "@eval-platform/eval-runtime";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import type { SuccessfulSamplingPage } from "../../db/catalog.js";
import { jsonBody } from "../../lib/request-body.js";
import { EVALUATION_BODY_BYTES, EVALUATION_SAMPLING_IDS, JSON_BODY_BYTES, SAMPLING_PAGE_SIZE_MAX } from "../../limits.js";
import {
  bodyErrorResponses,
  conflictResponse,
  entityIdSchema,
  errorResponses,
  idempotencyKeySchema,
  jsonBodyContent,
  notFoundResponse,
} from "../schemas.js";

const runHandleSchema = z.custom<RunHandle>();
const runSnapshotSchema = z.custom<RunSnapshot>();
const evaluationSchema = z.custom<EvaluationRecord>();
const samplingSchema = z.custom<SamplingSnapshot>();
const currentRunSchema = z.object({ runId: z.string(), stopRequested: z.literal(true).exactOptional() });
const projectParams = z.object({ projectId: entityIdSchema });
const projectRunParams = projectParams.extend({ runId: entityIdSchema });
const sampleFilter = { sampleId: entityIdSchema.exactOptional() };
const admissionErrors = { ...bodyErrorResponses, ...notFoundResponse, ...conflictResponse } as const;

export const startExecution = createRoute({
  method: "post",
  path: "/runs/execution",
  tags: ["Run"],
  summary: "Admit an Execution Run for a Project",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: {
    body: jsonBodyContent(z.strictObject({
      idempotencyKey: idempotencyKeySchema,
      projectId: entityIdSchema,
      executionConfigId: entityIdSchema,
    })),
  },
  responses: {
    201: jsonContent(responseSchema(runHandleSchema), "Admitted Run"),
    ...admissionErrors,
  },
});

export const startPipeline = createRoute({
  method: "post",
  path: "/runs/pipeline",
  tags: ["Run"],
  summary: "Admit an Execution-then-Evaluation Run for a Project",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: {
    body: jsonBodyContent(z.strictObject({
      idempotencyKey: idempotencyKeySchema,
      projectId: entityIdSchema,
      pipelineConfigId: entityIdSchema,
    })),
  },
  responses: {
    201: jsonContent(responseSchema(runHandleSchema), "Admitted Run"),
    ...admissionErrors,
  },
});

export const evaluate = createRoute({
  method: "post",
  path: "/projects/{projectId}/evaluations",
  tags: ["Run"],
  summary: "Admit an independent Evaluation Run over selected successful Samplings",
  middleware: [jsonBody(EVALUATION_BODY_BYTES)],
  request: {
    params: projectParams,
    body: jsonBodyContent(z.strictObject({
      evaluationConfigId: entityIdSchema,
      samplingIds: z.array(entityIdSchema).min(1).max(EVALUATION_SAMPLING_IDS)
        .refine((ids) => new Set(ids).size === ids.length, "must not contain duplicates"),
      idempotencyKey: idempotencyKeySchema,
    })),
  },
  responses: {
    202: jsonContent(responseSchema(runHandleSchema), "Admitted Run"),
    ...admissionErrors,
  },
});

export const getRun = createRoute({
  method: "get",
  path: "/runs/{runId}",
  tags: ["Run"],
  summary: "Get a Run snapshot",
  request: { params: z.object({ runId: entityIdSchema }) },
  responses: {
    200: jsonContent(responseSchema(runSnapshotSchema), "Run"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const getCurrentRun = createRoute({
  method: "get",
  path: "/projects/{projectId}/runs/current",
  tags: ["Run"],
  summary: "Get the Project's unfinished Run, if any",
  request: { params: projectParams },
  responses: {
    200: jsonContent(responseSchema(z.object({ run: currentRunSchema.nullable() })), "Current Run"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const stopRun = createRoute({
  method: "post",
  path: "/projects/{projectId}/runs/{runId}/stop",
  tags: ["Run"],
  summary: "Request interruption of the Project's current Run",
  request: { params: projectRunParams },
  responses: {
    202: jsonContent(responseSchema(z.object({ runId: z.string(), stopRequested: z.literal(true) })), "Stop requested"),
    ...errorResponses,
    ...notFoundResponse,
    ...conflictResponse,
  },
});

export const syncRunScores = createRoute({
  method: "post",
  path: "/projects/{projectId}/runs/{runId}/score-sync",
  tags: ["Run"],
  summary: "Sync the Run's Evaluator scores that are not yet in Langfuse",
  request: { params: projectRunParams },
  responses: {
    200: jsonContent(responseSchema(z.object({
      synced: z.number().int(), failed: z.number().int(), skipped: z.number().int(),
    })), "Sync outcome"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const getProjectRun = createRoute({
  method: "get",
  path: "/projects/{projectId}/runs/{runId}",
  tags: ["Run"],
  summary: "Get one Run of the Project",
  request: { params: projectRunParams },
  responses: {
    200: jsonContent(responseSchema(z.object({ run: runSnapshotSchema })), "Run"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const listProjectRunEvaluations = createRoute({
  method: "get",
  path: "/projects/{projectId}/runs/{runId}/evaluations",
  tags: ["Run"],
  summary: "List the Run's Evaluation records in admission order",
  request: { params: projectRunParams },
  responses: {
    200: jsonContent(responseSchema(z.object({ evaluations: z.array(evaluationSchema).readonly() })), "Evaluations"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const listSuccessfulSamplings = createRoute({
  method: "get",
  path: "/projects/{projectId}/samplings/successful",
  tags: ["Run"],
  summary: "Page through the Project's successful Samplings",
  request: {
    params: projectParams,
    query: z.strictObject({
      ...sampleFilter,
      afterSamplingId: entityIdSchema.exactOptional(),
      limit: z.coerce.number().int().min(1).max(SAMPLING_PAGE_SIZE_MAX).exactOptional(),
    }),
  },
  responses: {
    200: jsonContent(responseSchema(z.custom<SuccessfulSamplingPage>()), "Successful Samplings"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const selectSuccessfulSamplingIds = createRoute({
  method: "get",
  path: "/projects/{projectId}/samplings/successful/ids",
  tags: ["Run"],
  summary: "Select every successful Sampling ID that fits one evaluation request",
  request: { params: projectParams, query: z.strictObject(sampleFilter) },
  responses: {
    200: jsonContent(responseSchema(z.object({ samplingIds: z.array(z.string()).readonly() })), "Sampling IDs"),
    ...errorResponses,
    ...notFoundResponse,
    413: jsonContent(httpErrorSchema, "Selection exceeds one evaluation request"),
  },
});

export const getSampling = createRoute({
  method: "get",
  path: "/samplings/{samplingId}",
  tags: ["Run"],
  summary: "Get a Sampling",
  request: { params: z.object({ samplingId: entityIdSchema }) },
  responses: {
    200: jsonContent(responseSchema(samplingSchema), "Sampling"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const listSamplingEvaluations = createRoute({
  method: "get",
  path: "/samplings/{samplingId}/evaluations",
  tags: ["Run"],
  summary: "List a Sampling's Evaluation records",
  request: { params: z.object({ samplingId: entityIdSchema }) },
  responses: {
    200: jsonContent(responseSchema(z.array(evaluationSchema).readonly()), "Evaluations"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const getEvaluation = createRoute({
  method: "get",
  path: "/evaluations/{evaluationId}",
  tags: ["Run"],
  summary: "Get an Evaluation record",
  request: { params: z.object({ evaluationId: entityIdSchema }) },
  responses: {
    200: jsonContent(responseSchema(evaluationSchema), "Evaluation"),
    ...errorResponses,
    ...notFoundResponse,
  },
});
