import { ok } from "@eval-platform/eval-contracts/http";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./output-schemas.routes.js";

export const list: AppRouteHandler<typeof routes.list> = async (c) =>
  ok(c, await c.var.services.outputSchemas.list());

export const create: AppRouteHandler<typeof routes.create> = async (c) =>
  ok(c, await c.var.services.outputSchemas.create(c.req.valid("json")), 201);

export const get: AppRouteHandler<typeof routes.get> = async (c) => {
  const outputSchema = await c.var.services.outputSchemas.get(c.req.valid("param").outputSchemaId);
  if (!outputSchema) throw new HttpError("OUTPUT_SCHEMA_NOT_FOUND");
  return ok(c, outputSchema);
};

export const update: AppRouteHandler<typeof routes.update> = async (c) =>
  ok(c, await c.var.services.outputSchemas.updateMetadata(c.req.valid("param").outputSchemaId, c.req.valid("json")));

export const remove: AppRouteHandler<typeof routes.remove> = async (c) => {
  await c.var.services.outputSchemas.delete(c.req.valid("param").outputSchemaId);
  return c.body(null, 204);
};
