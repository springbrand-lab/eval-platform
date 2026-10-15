import { createRoute, z } from "@hono/zod-openapi";
import { AGENT_FRAMEWORKS, type AgentObservationRef, type Project, type RunHandle } from "@eval-platform/eval-contracts";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { catalogLabelSchema } from "../../db/catalog-metadata.js";
import type { ProjectView } from "../../db/project-store.js";
import { jsonBody } from "../../lib/request-body.js";
import { JSON_BODY_BYTES, PROJECT_BODY_BYTES, RUN_TARGET_IDS, SAMPLING_COUNT_MAX } from "../../limits.js";
import {
  bodyErrorResponses,
  conflictResponse,
  deletedResponse,
  entityIdSchema,
  errorResponses,
  idempotencyKeySchema,
  jsonBodyContent,
  notFoundResponse,
} from "../schemas.js";

const projectSchema = z.custom<Project>();
const projectViewSchema = z.custom<ProjectView>();
const observationSchema = z.custom<AgentObservationRef>();
const params = z.object({ projectId: entityIdSchema });
const positiveInteger = z.number().int().positive();
const samplingCountSchema = positiveInteger.max(SAMPLING_COUNT_MAX);
const unique = (ids: readonly string[]) => new Set(ids).size === ids.length;

const agentPolicy = {
  userAgentId: platformIdSchema,
  retryPolicy: z.strictObject({
    maxRestarts: z.number().int().min(0),
    initialBackoffMs: z.number().int().min(0),
    maxBackoffMs: z.number().int().min(0),
  }).exactOptional(),
  timeoutMs: positiveInteger.exactOptional(),
};

export const evaluationPlanSchema = z.strictObject({
  ...agentPolicy,
  evaluationConcurrency: positiveInteger,
  outputSchemaId: platformIdSchema,
});

export const projectCreateSchema = z.strictObject({
  name: catalogLabelSchema,
  description: catalogLabelSchema.exactOptional(),
  datasets: z.array(z.strictObject({
    datasetId: platformIdSchema,
    /** Omitted: every current member of the Dataset. */
    dataIds: z.array(platformIdSchema).min(1).max(RUN_TARGET_IDS).refine(unique, "must not contain duplicates").exactOptional(),
  })).min(1).max(RUN_TARGET_IDS)
    .refine((datasets) => unique(datasets.map((dataset) => dataset.datasetId)), "must not repeat a Dataset"),
  /** Default Sampling count of every selected Data. */
  samplingCount: samplingCountSchema,
  /** Per-Data overrides of `samplingCount`. */
  samplingCounts: z.record(platformIdSchema, samplingCountSchema)
    .refine((counts) => Object.keys(counts).length <= RUN_TARGET_IDS, `must name at most ${RUN_TARGET_IDS} Data`).exactOptional(),
  execution: z.strictObject({
    ...agentPolicy,
    framework: z.enum(AGENT_FRAMEWORKS),
    executionConcurrency: positiveInteger,
  }),
  evaluation: evaluationPlanSchema.exactOptional(),
  run: z.strictObject({ operation: z.enum(["execution", "pipeline"]), idempotencyKey: idempotencyKeySchema }),
}).refine((body) => body.run.operation !== "pipeline" || body.evaluation !== undefined,
  { path: ["evaluation"], message: "A pipeline Run requires an evaluation plan" });

export const list = createRoute({
  method: "get",
  path: "/",
  tags: ["Project"],
  summary: "List the user's Projects",
  responses: {
    200: jsonContent(responseSchema(z.array(projectSchema).readonly()), "Projects"),
    ...errorResponses,
  },
});

export const create = createRoute({
  method: "post",
  path: "/",
  tags: ["Project"],
  summary: "Snapshot the selected Data, freeze the Agent Configs and admit the first Run",
  middleware: [jsonBody(PROJECT_BODY_BYTES)],
  request: { body: jsonBodyContent(projectCreateSchema) },
  responses: {
    201: jsonContent(responseSchema(z.object({ project: projectSchema, run: z.custom<RunHandle>() })), "Created Project and its first Run"),
    ...bodyErrorResponses,
    ...notFoundResponse,
    ...conflictResponse,
  },
});

export const get = createRoute({
  method: "get",
  path: "/{projectId}",
  tags: ["Project"],
  summary: "Get a Project's fixed plan, bound ProjectSamples and current Run",
  request: { params },
  responses: {
    200: jsonContent(responseSchema(projectViewSchema), "Project"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const remove = createRoute({
  method: "delete",
  path: "/{projectId}",
  tags: ["Project"],
  summary: "Soft-delete a Project without an active Run",
  request: { params },
  responses: {
    ...deletedResponse,
    ...errorResponses,
    ...notFoundResponse,
    ...conflictResponse,
  },
});

export const replaceEvaluationPlan = createRoute({
  method: "put",
  path: "/{projectId}/evaluation-plan",
  tags: ["Project"],
  summary: "Replace the evaluation plan until the first evaluating Run locks it",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { params, body: jsonBodyContent(evaluationPlanSchema) },
  responses: {
    200: jsonContent(responseSchema(projectViewSchema), "Project"),
    ...bodyErrorResponses,
    ...notFoundResponse,
    ...conflictResponse,
  },
});

export const observeSampling = createRoute({
  method: "get",
  path: "/{projectId}/samplings/{samplingId}/observation",
  tags: ["Project"],
  summary: "Resolve the read-only Subject Chat observation of a current Sampling",
  request: { params: params.extend({ samplingId: entityIdSchema }) },
  responses: {
    200: jsonContent(responseSchema(observationSchema), "Observation target"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const observeEvaluation = createRoute({
  method: "get",
  path: "/{projectId}/evaluations/{evaluationId}/observation",
  tags: ["Project"],
  summary: "Resolve the read-only Evaluator Chat observation of a current Evaluation",
  request: { params: params.extend({ evaluationId: entityIdSchema }) },
  responses: {
    200: jsonContent(responseSchema(observationSchema), "Observation target"),
    ...errorResponses,
    ...notFoundResponse,
  },
});
