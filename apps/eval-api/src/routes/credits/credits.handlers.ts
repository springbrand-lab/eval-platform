import { ok } from "@eval-platform/eval-contracts/http";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./credits.routes.js";

export const balance: AppRouteHandler<typeof routes.balance> = async (c) =>
  ok(c, await c.env.sp.getCreditBalance(c.var.sessionToken));

export const listGrants: AppRouteHandler<typeof routes.listGrants> = async (c) =>
  ok(c, await c.env.sp.listCreditGrants(c.env.spAdminToken, {
    email: c.env.serviceAccount.email,
    limit: c.req.valid("query").limit,
  }));

/** Always targets the service account; the key namespaces the SP adjustment so retries grant once. */
export const grant: AppRouteHandler<typeof routes.grant> = async (c) => {
  const { units, idempotencyKey, note } = c.req.valid("json");
  return ok(c, await c.env.sp.grantCredits(c.env.spAdminToken, {
    email: c.env.serviceAccount.email,
    units,
    adjustmentId: `eval-platform:${idempotencyKey}`,
    ...(note === undefined || note === "" ? {} : { note }),
  }));
};
