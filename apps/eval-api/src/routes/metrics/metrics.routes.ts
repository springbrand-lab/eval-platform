import { createRoute, z } from "@hono/zod-openapi";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import type { DatasetOverview, ProjectOverview, SampleOverview, SamplingDetail } from "@eval-platform/eval-metrics";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { entityIdSchema, errorResponses, notFoundResponse } from "../schemas.js";

/** Repeated `runId` parameters narrow the metrics to those Runs. */
const scopeQuery = z.strictObject({
  runId: z.union([entityIdSchema, z.array(entityIdSchema)]).optional()
    .transform((runId) => runId === undefined ? undefined : [runId].flat()),
});
const projectParams = z.object({ projectId: entityIdSchema });
const queryErrors = {
  ...errorResponses,
  ...notFoundResponse,
} as const;

export const projectOverview = createRoute({
  method: "get",
  path: "/projects/{projectId}",
  tags: ["Metrics"],
  summary: "Project metrics overview",
  request: { params: projectParams, query: scopeQuery },
  responses: {
    200: jsonContent(responseSchema(z.custom<ProjectOverview>()), "Project overview"),
    ...queryErrors,
  },
});

export const datasetOverview = createRoute({
  method: "get",
  path: "/projects/{projectId}/datasets/{datasetId}",
  tags: ["Metrics"],
  summary: "Dataset metrics within a Project",
  request: { params: projectParams.extend({ datasetId: platformIdSchema }), query: scopeQuery },
  responses: {
    200: jsonContent(responseSchema(z.custom<DatasetOverview>()), "Dataset overview"),
    ...queryErrors,
  },
});

export const sampleOverview = createRoute({
  method: "get",
  path: "/projects/{projectId}/samples/{projectSampleId}",
  tags: ["Metrics"],
  summary: "ProjectSample metrics within a Project",
  request: { params: projectParams.extend({ projectSampleId: entityIdSchema }), query: scopeQuery },
  responses: {
    200: jsonContent(responseSchema(z.custom<SampleOverview>()), "Sample overview"),
    ...queryErrors,
  },
});

export const samplingDetail = createRoute({
  method: "get",
  path: "/projects/{projectId}/samplings/{samplingId}",
  tags: ["Metrics"],
  summary: "Sampling metrics detail within a Project",
  request: { params: projectParams.extend({ samplingId: entityIdSchema }), query: scopeQuery },
  responses: {
    200: jsonContent(responseSchema(z.custom<SamplingDetail>()), "Sampling detail"),
    ...queryErrors,
  },
});
