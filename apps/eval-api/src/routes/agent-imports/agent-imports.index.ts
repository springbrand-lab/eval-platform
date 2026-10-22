import { createRoute, z } from "@hono/zod-openapi";
import {
  AGENT_IMPORT_MAX_AGENTS, agentImportApplySchema, agentImportCandidatePageSchema, agentImportConfigSchema,
  agentImportPreviewSchema, agentImportSourceUserIdSchema, agentImportSourceUserPageSchema, agentImportTaskViewSchema,
} from "@eval-platform/eval-contracts";
import { ok } from "@eval-platform/eval-contracts/http";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { requireAgentImports } from "../../agent-imports/service.js";
import { createRouter } from "../../lib/create-app.js";
import { jsonBody } from "../../lib/request-body.js";
import { JSON_BODY_BYTES } from "../../limits.js";
import { bodyErrorResponses, conflictResponse, errorResponses, jsonBodyContent, notFoundResponse } from "../schemas.js";

const router = createRouter();
const tags = ["Agent imports"];
const taskParams = z.strictObject({ taskId: z.uuid().transform((id) => id.toLowerCase()) });
const search = {
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20),
};
router.openapi(createRoute({
  method: "get", path: "/config", tags, responses: {
    200: jsonContent(responseSchema(agentImportConfigSchema), "Optional source availability"), ...errorResponses,
  },
}), async (c) => ok(c, await c.var.services.agentImports?.config() ?? { enabled: false, maxAgents: AGENT_IMPORT_MAX_AGENTS }));
router.openapi(createRoute({
  method: "get", path: "/users", tags,
  request: { query: z.strictObject({
    ...search, q: z.string().trim().max(200).default(""), cursor: z.string().min(1).max(4096).optional(),
  }) },
  responses: { 200: jsonContent(responseSchema(agentImportSourceUserPageSchema), "Authorized source user page"), ...errorResponses },
}), async (c) => ok(c, await requireAgentImports(c.var.services.agentImports).users(c.req.valid("query"))));
router.openapi(createRoute({
  method: "get", path: "/users/{sourceUserId}/agents", tags,
  request: {
    params: z.strictObject({ sourceUserId: agentImportSourceUserIdSchema }),
    query: z.strictObject({ ...search, limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().max(2000).optional(), onlyMissing: z.enum(["true", "false"]).transform((value) => value === "true").optional() }),
  },
  responses: { 200: jsonContent(responseSchema(agentImportCandidatePageSchema), "Scoped source page"), ...errorResponses },
}), async (c) => ok(c, await requireAgentImports(c.var.services.agentImports).candidates(c.req.valid("param").sourceUserId, c.req.valid("query"))));
router.openapi(createRoute({
  method: "post", path: "/previews", tags, middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { body: jsonBodyContent(agentImportPreviewSchema) },
  responses: { 202: jsonContent(responseSchema(z.strictObject({ taskId: z.uuid() })), "Durable preview accepted"), ...bodyErrorResponses, ...conflictResponse },
}), async (c) => ok(c, await requireAgentImports(c.var.services.agentImports).preview(c.req.valid("json"), c.var.actor?.id), 202));
router.openapi(createRoute({
  method: "get", path: "/tasks/{taskId}", tags, request: { params: taskParams },
  responses: { 200: jsonContent(responseSchema(agentImportTaskViewSchema), "Durable task progress"), ...errorResponses, ...notFoundResponse },
}), async (c) => ok(c, await c.var.services.agentImportTasks.task(c.req.valid("param").taskId)));
router.openapi(createRoute({
  method: "post", path: "/tasks/{taskId}/apply", tags, middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { params: taskParams, body: jsonBodyContent(agentImportApplySchema) },
  responses: { 202: jsonContent(responseSchema(z.strictObject({ taskId: z.uuid() })), "Durable import accepted"),
    ...bodyErrorResponses, ...conflictResponse, ...notFoundResponse },
}), async (c) => ok(c, await requireAgentImports(c.var.services.agentImports).apply(c.req.valid("param").taskId, c.req.valid("json").idempotencyKey), 202));
export default router;
