import { ok } from "@eval-platform/eval-contracts/http";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./data.routes.js";

export const list: AppRouteHandler<typeof routes.list> = async (c) =>
  ok(c, await c.var.services.datasets.listData(c.req.valid("query").datasetId));

export const create: AppRouteHandler<typeof routes.create> = async (c) =>
  ok(c, await c.var.services.datasets.createData(c.req.valid("json"), c.req.valid("query")), 201);

export const get: AppRouteHandler<typeof routes.get> = async (c) => {
  const data = await c.var.services.datasets.getData(c.req.valid("param").dataId);
  if (!data) throw new HttpError("DATA_NOT_FOUND");
  return ok(c, data);
};

export const replace: AppRouteHandler<typeof routes.replace> = async (c) =>
  ok(c, await c.var.services.datasets.updateData(c.req.valid("param").dataId, c.req.valid("json")));

export const remove: AppRouteHandler<typeof routes.remove> = async (c) => {
  await c.var.services.datasets.deleteData(c.req.valid("param").dataId);
  return c.body(null, 204);
};

export const bindInitialResources: AppRouteHandler<typeof routes.bindInitialResources> = async (c) =>
  ok(c, await c.var.services.initialResources.bindData(c.req.valid("param").dataId, c.req.valid("json")));
