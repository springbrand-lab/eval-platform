import { createRoute, z } from "@hono/zod-openapi";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { jsonBody } from "../../lib/request-body.js";
import { JSON_BODY_BYTES } from "../../limits.js";
import type { EvalSpCreditBalance, EvalSpCreditGrant, EvalSpCreditGrantRecord } from "../../sp/client.js";
import { bodyErrorResponses, conflictResponse, errorResponses, jsonBodyContent } from "../schemas.js";

/** Prefixed into the SP adjustment ID `eval-platform:<key>`, which SP limits to 255 characters. */
const grantKeySchema = z.string().trim().min(1).max(200)
  .refine((value) => !/\p{Cc}/u.test(value), "must not contain control characters");
const grantInputSchema = z.strictObject({
  units: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  idempotencyKey: grantKeySchema,
  note: z.string().trim().max(500).optional(),
});

export const balance = createRoute({
  method: "get",
  path: "/",
  tags: ["Credits"],
  summary: "Read the service account's Eval SP credit balance",
  responses: {
    200: jsonContent(responseSchema(z.custom<EvalSpCreditBalance>()), "Credit balance"),
    ...errorResponses,
  },
});

export const listGrants = createRoute({
  method: "get",
  path: "/grants",
  tags: ["Credits"],
  summary: "List manual credit grants to the service account",
  request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }) },
  responses: {
    200: jsonContent(responseSchema(z.array(z.custom<EvalSpCreditGrantRecord>()).readonly()), "Credit grants"),
    ...errorResponses,
  },
});

export const grant = createRoute({
  method: "post",
  path: "/grants",
  tags: ["Credits"],
  summary: "Grant credits to the service account",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { body: jsonBodyContent(grantInputSchema) },
  responses: {
    200: jsonContent(responseSchema(z.custom<EvalSpCreditGrant>()), "Credit grant"),
    ...bodyErrorResponses,
    ...conflictResponse,
  },
});
