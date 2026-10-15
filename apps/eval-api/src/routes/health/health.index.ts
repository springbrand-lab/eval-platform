import { createRoute, z } from "@hono/zod-openapi";
import { ok } from "@eval-platform/eval-contracts/http";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { createRouter } from "../../lib/create-app.js";

const healthCheck = createRoute({
  method: "get",
  path: "/healthz",
  tags: ["Health"],
  summary: "The HTTP process is serving",
  responses: {
    200: jsonContent(responseSchema(z.object({ status: z.literal("ok") })), "Health check"),
  },
});

export default createRouter().openapi(healthCheck, (c) => ok(c, { status: "ok" as const }));
