import { createRoute, z } from "@hono/zod-openapi";
import { dataInputSchema, platformIdSchema, type Data } from "@eval-platform/eval-dataset";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { dataInitialResourcePatchSchema } from "../../initial-resources.js";
import { jsonBody } from "../../lib/request-body.js";
import { JSON_BODY_BYTES, METADATA_BODY_BYTES } from "../../limits.js";
import {
  bodyErrorResponses,
  conflictResponse,
  deletedResponse,
  errorResponses,
  jsonBodyContent,
  notFoundResponse,
} from "../schemas.js";

const dataSchema = z.custom<Data>();
const params = z.object({ dataId: platformIdSchema });

export const list = createRoute({
  method: "get",
  path: "/",
  tags: ["Data"],
  summary: "List the user's Data, optionally within one Dataset",
  request: { query: z.strictObject({ datasetId: platformIdSchema.exactOptional() }) },
  responses: {
    200: jsonContent(responseSchema(z.array(dataSchema).readonly()), "Data"),
    ...errorResponses,
  },
});

export const create = createRoute({
  method: "post",
  path: "/",
  tags: ["Data"],
  summary: "Create Data",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { body: jsonBodyContent(dataInputSchema) },
  responses: {
    201: jsonContent(responseSchema(dataSchema), "Created Data"),
    ...bodyErrorResponses,
    ...notFoundResponse,
  },
});

export const get = createRoute({
  method: "get",
  path: "/{dataId}",
  tags: ["Data"],
  summary: "Get Data",
  request: { params },
  responses: {
    200: jsonContent(responseSchema(dataSchema), "Data"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const replace = createRoute({
  method: "put",
  path: "/{dataId}",
  tags: ["Data"],
  summary: "Replace Data content",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { params, body: jsonBodyContent(dataInputSchema) },
  responses: {
    200: jsonContent(responseSchema(dataSchema), "Data"),
    ...bodyErrorResponses,
    ...notFoundResponse,
  },
});

export const remove = createRoute({
  method: "delete",
  path: "/{dataId}",
  tags: ["Data"],
  summary: "Soft-delete unreferenced Data; deleting absent Data succeeds",
  request: { params },
  responses: {
    ...deletedResponse,
    ...errorResponses,
    ...conflictResponse,
  },
});

export const bindInitialResources = createRoute({
  method: "patch",
  path: "/{dataId}/initial-resources",
  tags: ["Data"],
  summary: "Bind or clear the Data's initial Materials and Session",
  middleware: [jsonBody(METADATA_BODY_BYTES)],
  request: { params, body: jsonBodyContent(dataInitialResourcePatchSchema) },
  responses: {
    200: jsonContent(responseSchema(dataSchema), "Data"),
    ...bodyErrorResponses,
    ...notFoundResponse,
  },
});
