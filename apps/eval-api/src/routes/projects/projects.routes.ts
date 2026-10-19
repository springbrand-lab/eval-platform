import { createRoute, z } from "@hono/zod-openapi";
import type { AgentObservationRef, EvaluationOutputSchemaDocument, Project, RunHandle } from "@eval-platform/eval-contracts";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import type { ProjectView } from "@eval-platform/eval-runtime";
import { jsonBody } from "../../lib/request-body.js";
import { JSON_BODY_BYTES, PROJECT_BODY_BYTES } from "../../limits.js";
import { evaluationPlanSchema, projectCreateSchema } from "../../projects/schemas.js";
import {
  bodyErrorResponses,
  conflictResponse,
  deletedResponse,
  entityIdSchema,
  errorResponses,
  jsonBodyContent,
  notFoundResponse,
} from "../schemas.js";

const projectSchema = z.custom<Project>();
const projectViewSchema = z.custom<ProjectView>();
const observationSchema = z.custom<AgentObservationRef>();
const params = z.object({ projectId: entityIdSchema });
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
  summary: "Snapshot the selected Data, freeze the Agent Configs and admit the first Run; the key replays the same creation",
  middleware: [jsonBody(PROJECT_BODY_BYTES)],
  request: { body: jsonBodyContent(projectCreateSchema) },
  responses: {
    201: jsonContent(responseSchema(z.object({ project: projectSchema, run: z.custom<RunHandle>().nullable() })), "Created or replayed Project and its first Run"),
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

export const evaluationOutputSchema = createRoute({
  method: "get",
  path: "/{projectId}/evaluation-output-schema",
  tags: ["Project"],
  summary: "Read the Project-bound output Schema and its reference, including soft-deleted catalog entries",
  request: { params },
  responses: {
    200: jsonContent(responseSchema(z.custom<EvaluationOutputSchemaDocument>().nullable()), "Project Schema, or null without an evaluation plan"),
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

const observedParams = params.extend({
  kind: z.enum(["samplings", "evaluations"]),
  id: entityIdSchema,
});

export const observeChat = createRoute({
  method: "get",
  path: "/{projectId}/{kind}/{id}/observation/{part}",
  tags: ["Project"],
  summary: "Read the Subject or Evaluator Chat's messages, Workspace tree or trajectory page (read-only)",
  request: {
    params: observedParams.extend({ part: z.enum(["messages", "tree", "trajectory"]) }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      beforeSeq: z.coerce.number().int().positive().optional(),
    }),
  },
  responses: {
    200: jsonContent(responseSchema(z.unknown()), "Observed Chat data"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const observeFile = createRoute({
  method: "get",
  path: "/{projectId}/{kind}/{id}/observation/file",
  tags: ["Project"],
  summary: "Download one Workspace file of the observed Chat (read-only, never rendered inline)",
  request: { params: observedParams, query: z.object({ path: z.string().min(1).max(4096) }) },
  responses: {
    200: { description: "File bytes", content: { "application/octet-stream": { schema: z.string() } } },
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const resourceSnapshot = createRoute({
  method: "get",
  path: "/{projectId}/{kind}/{id}/attempts/{attemptId}/resource-snapshot",
  tags: ["Project"],
  summary: "Download one Subject or Evaluator Attempt's stored raw resource snapshot, streamed unparsed",
  request: { params: observedParams.extend({ attemptId: entityIdSchema }) },
  responses: {
    200: { description: "Raw resource snapshot JSON", content: { "application/json": { schema: z.unknown() } } },
    ...errorResponses,
    ...notFoundResponse,
  },
});
