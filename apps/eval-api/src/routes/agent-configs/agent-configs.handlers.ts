import { ok } from "@eval-platform/eval-contracts/http";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./agent-configs.routes.js";

export const list: AppRouteHandler<typeof routes.list> = async (c) =>
  ok(c, await c.env.sp.listAgentConfigs(c.var.sessionToken));

export const create: AppRouteHandler<typeof routes.create> = async (c) =>
  ok(c, await c.env.sp.createAgentConfig(c.var.sessionToken, c.req.valid("json")), 201);

export const get: AppRouteHandler<typeof routes.get> = async (c) =>
  ok(c, await c.env.sp.getAgentConfig(c.var.sessionToken, c.req.valid("param").id));

export const update: AppRouteHandler<typeof routes.update> = async (c) =>
  ok(c, await c.env.sp.updateAgentConfig(c.var.sessionToken, c.req.valid("param").id, c.req.valid("json")));

export const remove: AppRouteHandler<typeof routes.remove> = async (c) => {
  await c.env.sp.deleteAgentConfig(c.var.sessionToken, c.req.valid("param").id);
  return c.body(null, 204);
};
