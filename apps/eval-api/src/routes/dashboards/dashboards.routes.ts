import { dashboardSchema } from "@eval-platform/eval-contracts";
import { createRoute, z } from "@hono/zod-openapi";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { dashboardCreateInputSchema, dashboardUpdateInputSchema } from "../../dashboards/schemas.js";
import { jsonBody } from "../../lib/request-body.js";
import { JSON_BODY_BYTES } from "../../limits.js";
import { bodyErrorResponses, conflictResponse, errorResponses, jsonBodyContent, notFoundResponse } from "../schemas.js";

const query = z.strictObject({});
const params = z.strictObject({ dashboardId: dashboardSchema.shape.dashboardId });

export const list = createRoute({
  method: "get", path: "/", tags: ["Dashboards"], summary: "List saved Dashboards",
  request: { query },
  responses: {
    200: jsonContent(responseSchema(z.array(dashboardSchema).readonly()), "Saved Dashboards"),
    ...errorResponses,
  },
});

export const create = createRoute({
  method: "post", path: "/", tags: ["Dashboards"], summary: "Create a saved Dashboard",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { query, body: jsonBodyContent(dashboardCreateInputSchema) },
  responses: {
    201: jsonContent(responseSchema(dashboardSchema), "Created Dashboard"),
    ...bodyErrorResponses, ...notFoundResponse, ...conflictResponse,
  },
});

export const get = createRoute({
  method: "get", path: "/{dashboardId}", tags: ["Dashboards"], summary: "Reopen a saved Dashboard",
  request: { params, query },
  responses: {
    200: jsonContent(responseSchema(dashboardSchema), "Saved Dashboard"),
    ...errorResponses, ...notFoundResponse,
  },
});

export const update = createRoute({
  method: "put", path: "/{dashboardId}", tags: ["Dashboards"], summary: "Replace a saved Dashboard configuration",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { params, query, body: jsonBodyContent(dashboardUpdateInputSchema) },
  responses: {
    200: jsonContent(responseSchema(dashboardSchema), "Updated Dashboard"),
    ...bodyErrorResponses, ...notFoundResponse, ...conflictResponse,
  },
});
