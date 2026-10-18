import { createRoute, z } from "@hono/zod-openapi";
import type { AgentOption } from "../../agent-configs.js";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { errorResponses } from "../schemas.js";

export const list = createRoute({
  method: "get",
  path: "/",
  tags: ["Agent"],
  summary: "List Agent choices filtered by execution or evaluation purpose",
  request: { query: z.strictObject({
    role: z.enum(["subject", "evaluator"]).exactOptional(),
    purpose: z.enum(["execution", "evaluation"]).exactOptional(),
  }) },
  responses: {
    200: jsonContent(responseSchema(z.array(z.custom<AgentOption>()).readonly()), "Agent choices with current purpose metadata"),
    ...errorResponses,
  },
});
