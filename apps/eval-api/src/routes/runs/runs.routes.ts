import { createRoute, z } from "@hono/zod-openapi";
import { RUN_OPERATIONS, type EvaluationRecord, type RunHandle, type RunSnapshot } from "@eval-platform/eval-contracts";
import { httpErrorSchema } from "@eval-platform/eval-contracts/http-errors";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import type { RunPreview, SamplingSnapshot } from "@eval-platform/eval-runtime";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { jsonBody } from "../../lib/request-body.js";
import { RUN_BODY_BYTES, RUN_PREVIEW_BODY_BYTES, RUN_TARGET_IDS } from "../../limits.js";
import {
  bodyErrorResponses,
  conflictResponse,
  entityIdSchema,
  errorResponses,
  idempotencyKeySchema,
  jsonBodyContent,
  notFoundResponse,
  unique,
} from "../schemas.js";

const runHandleSchema = z.custom<RunHandle>();
const runSnapshotSchema = z.custom<RunSnapshot>();
const evaluationSchema = z.custom<EvaluationRecord>();
const samplingSchema = z.custom<SamplingSnapshot>();
const currentRunSchema = z.object({ runId: z.string(), stopRequested: z.literal(true).exactOptional() });
const projectParams = z.object({ projectId: entityIdSchema });
const projectRunParams = projectParams.extend({ runId: entityIdSchema });
const admissionErrors = {
  ...bodyErrorResponses, ...notFoundResponse, ...conflictResponse,
  413: jsonContent(httpErrorSchema, "Request body or expanded selection is too large"),
} as const;
const idList = z.array(entityIdSchema).max(RUN_TARGET_IDS);

/** What the user picked inside the Project snapshot; expansion and deduplication belong to Runtime. */
const selectorSchema = z.strictObject({
  all: z.literal(true).exactOptional(),
  datasetIds: z.array(platformIdSchema).min(1).max(RUN_TARGET_IDS).exactOptional(),
  projectSampleIds: idList.min(1).exactOptional(),
  samplingIds: idList.min(1).exactOptional(),
}).refine((selector) => Object.keys(selector).length > 0, "Select at least one target")
  .refine((selector) => (selector.datasetIds?.length ?? 0) + (selector.projectSampleIds?.length ?? 0)
    + (selector.samplingIds?.length ?? 0) <= RUN_TARGET_IDS, `Select at most ${RUN_TARGET_IDS} IDs`);

/** The fixed targets a preview returned, submitted unchanged. */
const targetsSchema = z.strictObject({
  projectSampleIds: idList.refine(unique, "must not contain duplicates"),
  samplingIds: idList.refine(unique, "must not contain duplicates"),
}).refine((targets) => targets.projectSampleIds.length + targets.samplingIds.length <= RUN_TARGET_IDS,
  `Submit at most ${RUN_TARGET_IDS} target IDs`);

export const previewRun = createRoute({
  method: "post",
  path: "/projects/{projectId}/runs/preview",
  tags: ["Run"],
  summary: "Expand a selection inside the Project snapshot into the fixed targets to submit",
  middleware: [jsonBody(RUN_PREVIEW_BODY_BYTES)],
  request: {
    params: projectParams,
    body: jsonBodyContent(z.strictObject({ operation: z.enum(RUN_OPERATIONS), selector: selectorSchema })),
  },
  responses: {
    200: jsonContent(responseSchema(z.custom<RunPreview>()), "Run preview"),
    ...admissionErrors,
  },
});

export const submitRun = createRoute({
  method: "post",
  path: "/projects/{projectId}/runs",
  tags: ["Run"],
  summary: "Admit a Run over previewed targets",
  middleware: [jsonBody(RUN_BODY_BYTES)],
  request: {
    params: projectParams,
    body: jsonBodyContent(z.strictObject({
      idempotencyKey: idempotencyKeySchema,
      operation: z.enum(RUN_OPERATIONS),
      selector: selectorSchema,
      targets: targetsSchema,
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

export const collectExecution = createRoute({
  method: "post", path: "/projects/{projectId}/samplings/{samplingId}/collect", tags: ["Run"],
  summary: "Recollect output and freeze evidence from an already completed Subject without executing it",
  request: { params: projectParams.extend({ samplingId: entityIdSchema }) },
  responses: { 202: jsonContent(responseSchema(z.object({ runId: z.string(), queued: z.boolean() })), "Collection requested"), ...errorResponses, ...notFoundResponse, ...conflictResponse },
});
export const collectEvaluation = createRoute({
  method: "post", path: "/projects/{projectId}/evaluations/{evaluationId}/collect", tags: ["Run"],
  summary: "Recollect an already completed Evaluator's output without evaluating again",
  request: { params: projectParams.extend({ evaluationId: entityIdSchema }) },
  responses: { 202: jsonContent(responseSchema(z.object({ runId: z.string(), queued: z.boolean() })), "Collection requested"), ...errorResponses, ...notFoundResponse, ...conflictResponse },
});
