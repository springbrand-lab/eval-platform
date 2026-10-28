import { createRoute, z } from "@hono/zod-openapi";
import { httpErrorSchema } from "@eval-platform/eval-contracts/http-errors";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import type { DatasetOverview, ProjectComparisonView, ProjectOverview, SampleOverview, SamplingDetail } from "@eval-platform/eval-metrics";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { COMPARISON_PROJECTS } from "../../limits.js";
import { entityIdSchema, errorResponses, notFoundResponse, unique } from "../schemas.js";

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

export const comparison = createRoute({
  method: "get",
  path: "/comparison",
  tags: ["Metrics"],
  summary: "Compare Projects in one owner-scoped snapshot",
  request: {
    query: z.strictObject({
      projectId: z.array(entityIdSchema).min(2).max(COMPARISON_PROJECTS).refine(unique, "must not repeat a Project ID")
        .openapi({ uniqueItems: true, param: { style: "form", explode: true } }),
      datasetId: platformIdSchema.optional(),
      jsonPointer: z.string().optional(),
    }),
  },
  responses: {
    200: jsonContent(responseSchema(z.custom<ProjectComparisonView>().openapi({ type: "object" })), "Project comparison"),
    400: jsonContent(httpErrorSchema, "Invalid Metrics query"),
    ...queryErrors,
  },
});

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
