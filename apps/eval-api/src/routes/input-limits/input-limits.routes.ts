import { createRoute } from "@hono/zod-openapi";
import { evalInputLimitsSchema } from "@eval-platform/eval-contracts";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { errorResponses } from "../schemas.js";

export const get = createRoute({
  method: "get", path: "/", tags: ["Input limits"], summary: "Read input bounds enforced by this API",
  responses: { 200: jsonContent(responseSchema(evalInputLimitsSchema), "Input bounds"), ...errorResponses },
});
