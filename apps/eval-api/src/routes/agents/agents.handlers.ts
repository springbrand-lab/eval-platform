import { ok } from "@eval-platform/eval-contracts/http";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./agents.routes.js";

export const list: AppRouteHandler<typeof routes.list> = async (c) =>
  ok(c, await c.var.services.catalog.listAgents(c.req.valid("query").role));
