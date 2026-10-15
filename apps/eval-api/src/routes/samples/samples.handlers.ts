import { ok } from "@eval-platform/eval-contracts/http";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./samples.routes.js";

export const list: AppRouteHandler<typeof routes.list> = async (c) =>
  ok(c, await c.var.services.catalog.listSamples(c.req.valid("query").dataId));

export const create: AppRouteHandler<typeof routes.create> = async (c) =>
  ok(c, await c.var.services.catalog.createSample(c.req.valid("json").dataId), 201);

export const get: AppRouteHandler<typeof routes.get> = async (c) => {
  const sample = await c.var.services.catalog.getSample(c.req.valid("param").sampleId);
  if (!sample) throw new HttpError("SAMPLE_NOT_FOUND");
  return ok(c, sample);
};
