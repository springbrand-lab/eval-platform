import { createRoute, z } from "@hono/zod-openapi";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import type { Sample } from "@eval-platform/eval-runtime";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { jsonBody } from "../../lib/request-body.js";
import { METADATA_BODY_BYTES } from "../../limits.js";
import {
  bodyErrorResponses,
  entityIdSchema,
  errorResponses,
  jsonBodyContent,
  notFoundResponse,
} from "../schemas.js";

const sampleSchema = z.custom<Sample>();

export const list = createRoute({
  method: "get",
  path: "/",
  tags: ["Sample"],
  summary: "List the Samples created from one Data",
  request: { query: z.strictObject({ dataId: platformIdSchema }) },
  responses: {
    200: jsonContent(responseSchema(z.array(sampleSchema).readonly()), "Samples"),
    ...errorResponses,
  },
});

export const create = createRoute({
  method: "post",
  path: "/",
  tags: ["Sample"],
  summary: "Create a Sample from Data",
  middleware: [jsonBody(METADATA_BODY_BYTES)],
  request: { body: jsonBodyContent(z.strictObject({ dataId: platformIdSchema })) },
  responses: {
    201: jsonContent(responseSchema(sampleSchema), "Created Sample"),
    ...bodyErrorResponses,
    ...notFoundResponse,
  },
});

export const get = createRoute({
  method: "get",
  path: "/{sampleId}",
  tags: ["Sample"],
  summary: "Get a Sample",
  request: { params: z.object({ sampleId: entityIdSchema }) },
  responses: {
    200: jsonContent(responseSchema(sampleSchema), "Sample"),
    ...errorResponses,
    ...notFoundResponse,
  },
});
