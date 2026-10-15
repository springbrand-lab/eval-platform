import { createRoute, z } from "@hono/zod-openapi";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import type { Project } from "@eval-platform/eval-contracts";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { catalogLabelSchema } from "../../db/catalog-metadata.js";
import { jsonBody } from "../../lib/request-body.js";
import { METADATA_BODY_BYTES } from "../../limits.js";
import {
  bodyErrorResponses,
  conflictResponse,
  entityIdSchema,
  errorResponses,
  jsonBodyContent,
  notFoundResponse,
} from "../schemas.js";

/** The public Project contract; the bound output format is exposed only by its ID. */
const projectSchema = z.custom<Project>();

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
  summary: "Create an empty Project on the deployed SP source branch",
  middleware: [jsonBody(METADATA_BODY_BYTES)],
  request: { body: jsonBodyContent(z.strictObject({ name: catalogLabelSchema })) },
  responses: {
    201: jsonContent(responseSchema(projectSchema), "Created Project"),
    ...bodyErrorResponses,
  },
});

export const get = createRoute({
  method: "get",
  path: "/{projectId}",
  tags: ["Project"],
  summary: "Get a Project",
  request: { params },
  responses: {
    200: jsonContent(responseSchema(projectSchema), "Project"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const bindOutputSchema = createRoute({
  method: "put",
  path: "/{projectId}/evaluation-output-schema",
  tags: ["Project"],
  summary: "Select or clear the Project's evaluation output format before its first Evaluation Run",
  middleware: [jsonBody(METADATA_BODY_BYTES)],
  request: { params, body: jsonBodyContent(z.strictObject({ outputSchemaId: platformIdSchema.nullable() })) },
  responses: {
    200: jsonContent(responseSchema(projectSchema), "Project"),
    ...bodyErrorResponses,
    ...notFoundResponse,
    ...conflictResponse,
  },
});
