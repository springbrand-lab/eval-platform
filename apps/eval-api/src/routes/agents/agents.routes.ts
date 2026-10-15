import { createRoute, z } from "@hono/zod-openapi";
import type { AgentOption } from "@eval-platform/eval-runtime";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { errorResponses } from "../schemas.js";

export const list = createRoute({
  method: "get",
  path: "/",
  tags: ["Agent"],
  summary: "List Agent choices for Subject and Evaluator roles",
  request: { query: z.strictObject({ role: z.enum(["subject", "evaluator"]).exactOptional() }) },
  responses: {
    200: jsonContent(responseSchema(z.array(z.custom<AgentOption>()).readonly()), "Agent choices"),
    ...errorResponses,
  },
});
