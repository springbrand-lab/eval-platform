import { createRoute, z } from "@hono/zod-openapi";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import type { OutputSchemaRecord } from "../../db/output-schemas.js";
import { catalogLabelSchema, catalogMetadataPatchSchema } from "../../db/catalog-metadata.js";
import { jsonBody } from "../../lib/request-body.js";
import { METADATA_BODY_BYTES, OUTPUT_SCHEMA_BODY_BYTES } from "../../limits.js";
import {
  bodyErrorResponses,
  conflictResponse,
  deletedResponse,
  errorResponses,
  jsonBodyContent,
  notFoundResponse,
} from "../schemas.js";

const outputSchemaSchema = z.custom<OutputSchemaRecord>();
const params = z.object({ outputSchemaId: platformIdSchema });

export const list = createRoute({
  method: "get",
  path: "/",
  tags: ["Output format"],
  summary: "List the user's evaluation output formats",
  responses: {
    200: jsonContent(responseSchema(z.array(outputSchemaSchema).readonly()), "Output formats"),
    ...errorResponses,
  },
});

export const create = createRoute({
  method: "post",
  path: "/",
  tags: ["Output format"],
  summary: "Upload a named evaluation output JSON Schema file",
  middleware: [jsonBody(OUTPUT_SCHEMA_BODY_BYTES)],
  request: {
    body: jsonBodyContent(z.strictObject({
      name: catalogLabelSchema,
      description: catalogLabelSchema,
      content: z.string(),
    })),
  },
  responses: {
    201: jsonContent(responseSchema(outputSchemaSchema), "Created output format"),
    ...bodyErrorResponses,
  },
});

export const get = createRoute({
  method: "get",
  path: "/{outputSchemaId}",
  tags: ["Output format"],
  summary: "Get an evaluation output format",
  request: { params },
  responses: {
    200: jsonContent(responseSchema(outputSchemaSchema), "Output format"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const update = createRoute({
  method: "patch",
  path: "/{outputSchemaId}",
  tags: ["Output format"],
  summary: "Edit an output format's name or description",
  middleware: [jsonBody(METADATA_BODY_BYTES)],
  request: { params, body: jsonBodyContent(catalogMetadataPatchSchema) },
  responses: {
    200: jsonContent(responseSchema(outputSchemaSchema), "Output format"),
    ...bodyErrorResponses,
    ...notFoundResponse,
  },
});

export const remove = createRoute({
  method: "delete",
  path: "/{outputSchemaId}",
  tags: ["Output format"],
  summary: "Soft-delete an output format; Projects that already use it keep reading it by ID",
  request: { params },
  responses: {
    ...deletedResponse,
    ...errorResponses,
    ...notFoundResponse,
    ...conflictResponse,
  },
});
