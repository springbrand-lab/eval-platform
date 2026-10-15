import { ok } from "@eval-platform/eval-contracts/http";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./projects.routes.js";

export const list: AppRouteHandler<typeof routes.list> = async (c) =>
  ok(c, await c.var.services.catalog.listProjects());

export const create: AppRouteHandler<typeof routes.create> = async (c) =>
  ok(c, await c.var.services.catalog.createProject(c.req.valid("json")), 201);

export const get: AppRouteHandler<typeof routes.get> = async (c) => {
  const project = await c.var.services.catalog.getProject(c.req.valid("param").projectId);
  if (!project) throw new HttpError("PROJECT_NOT_FOUND");
  return ok(c, project);
};

export const bindOutputSchema: AppRouteHandler<typeof routes.bindOutputSchema> = async (c) => {
  const { projectId } = c.req.valid("param");
  const { outputSchemaId } = c.req.valid("json");
  return ok(c, await c.var.services.catalog.bindEvaluationOutputSchema(projectId, outputSchemaId));
};
