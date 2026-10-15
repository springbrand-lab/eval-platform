import { ok } from "@eval-platform/eval-contracts/http";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./agent-configs.routes.js";

export const list: AppRouteHandler<typeof routes.list> = async (c) =>
  ok(c, await c.var.services.agentConfigs.list());

export const create: AppRouteHandler<typeof routes.create> = async (c) =>
  ok(c, await c.var.services.agentConfigs.create(c.req.valid("json")), 201);

export const get: AppRouteHandler<typeof routes.get> = async (c) =>
  ok(c, await c.var.services.agentConfigs.get(c.req.valid("param").id));

export const update: AppRouteHandler<typeof routes.update> = async (c) =>
  ok(c, await c.var.services.agentConfigs.update(c.req.valid("param").id, c.req.valid("json")));

export const remove: AppRouteHandler<typeof routes.remove> = async (c) => {
  await c.var.services.agentConfigs.remove(c.req.valid("param").id);
  return c.body(null, 204);
};
