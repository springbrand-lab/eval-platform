import { createRoute, z } from "@hono/zod-openapi";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { errorResponses } from "../schemas.js";

export const me = createRoute({
  method: "get",
  path: "/",
  tags: ["Session"],
  summary: "The verified Eval SP user",
  responses: {
    200: jsonContent(responseSchema(z.object({
      id: z.string(),
      role: z.enum(["user", "admin", "super_admin"]),
    })), "Current user"),
    ...errorResponses,
  },
});
