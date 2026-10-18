import { createRoute, z } from "@hono/zod-openapi";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { jsonBody } from "../../lib/request-body.js";
import { JSON_BODY_BYTES } from "../../limits.js";
import { FROZEN_SLUG_PREFIX, isReservedSlug } from "../../agent-configs.js";
import type { EvalSpAgentConfig } from "../../sp/client.js";
import {
  bodyErrorResponses,
  conflictResponse,
  deletedResponse,
  errorResponses,
  jsonBodyContent,
  notFoundResponse,
} from "../schemas.js";

const agentConfigSchema = z.custom<EvalSpAgentConfig>();
/** SP owns the Agent Config input contract; Eval reserves the frozen-copy slug prefix and create-only purpose field. */
const agentConfigInputSchema = z.record(z.string(), z.unknown())
  .refine((body) => !isReservedSlug(body.slug), { path: ["slug"], message: `must not start with ${FROZEN_SLUG_PREFIX}` });
const agentConfigCreateInputSchema = agentConfigInputSchema.refine(
  (body) => body.purpose === "execution" || body.purpose === "evaluation",
  { path: ["purpose"], message: "purpose must be execution or evaluation" },
);
const params = z.object({ id: platformIdSchema });

export const list = createRoute({
  method: "get",
  path: "/",
  tags: ["Agent Config"],
  summary: "List the user's Eval SP Agent Configs, excluding frozen Project copies",
  responses: {
    200: jsonContent(responseSchema(z.array(agentConfigSchema).readonly()), "Agent Configs"),
    ...errorResponses,
  },
});

export const create = createRoute({
  method: "post",
  path: "/",
  tags: ["Agent Config"],
  summary: "Create an Eval SP Agent Config",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { body: jsonBodyContent(agentConfigCreateInputSchema) },
  responses: {
    201: jsonContent(responseSchema(agentConfigSchema), "Created Agent Config"),
    ...bodyErrorResponses,
    ...conflictResponse,
  },
});

export const get = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Agent Config"],
  summary: "Get an Eval SP Agent Config, including a frozen Project copy (read-only)",
  request: { params },
  responses: {
    200: jsonContent(responseSchema(agentConfigSchema), "Agent Config"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const update = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Agent Config"],
  summary: "Update an Eval SP Agent Config; frozen Project copies are rejected",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { params, body: jsonBodyContent(agentConfigInputSchema) },
  responses: {
    200: jsonContent(responseSchema(agentConfigSchema), "Updated Agent Config"),
    ...bodyErrorResponses,
    ...notFoundResponse,
    ...conflictResponse,
  },
});

export const remove = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Agent Config"],
  summary: "Delete an Eval SP Agent Config; frozen Project copies are rejected",
  request: { params },
  responses: {
    ...deletedResponse,
    ...errorResponses,
    ...notFoundResponse,
    ...conflictResponse,
  },
});
