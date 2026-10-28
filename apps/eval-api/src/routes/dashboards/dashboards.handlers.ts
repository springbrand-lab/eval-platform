import { ok } from "@eval-platform/eval-contracts/http";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./dashboards.routes.js";

export const list: AppRouteHandler<typeof routes.list> = async (c) =>
  ok(c, await c.var.services.dashboards.list());

export const create: AppRouteHandler<typeof routes.create> = async (c) =>
  ok(c, await c.var.services.dashboards.create(c.req.valid("json")), 201);

export const get: AppRouteHandler<typeof routes.get> = async (c) =>
  ok(c, await c.var.services.dashboards.get(c.req.valid("param").dashboardId));

export const update: AppRouteHandler<typeof routes.update> = async (c) =>
  ok(c, await c.var.services.dashboards.update(c.req.valid("param").dashboardId, c.req.valid("json")));
