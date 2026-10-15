import { ok } from "@eval-platform/eval-contracts/http";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./projects.routes.js";

export const list: AppRouteHandler<typeof routes.list> = async (c) =>
  ok(c, await c.var.services.projects.list());

export const create: AppRouteHandler<typeof routes.create> = async (c) =>
  ok(c, await c.var.services.projects.create(c.req.valid("json")), 201);

export const get: AppRouteHandler<typeof routes.get> = async (c) => {
  const project = await c.var.services.projects.get(c.req.valid("param").projectId);
  if (!project) throw new HttpError("PROJECT_NOT_FOUND");
  return ok(c, project);
};

export const remove: AppRouteHandler<typeof routes.remove> = async (c) => {
  await c.var.services.projects.delete(c.req.valid("param").projectId);
  return c.body(null, 204);
};

export const replaceEvaluationPlan: AppRouteHandler<typeof routes.replaceEvaluationPlan> = async (c) =>
  ok(c, await c.var.services.projects.replaceEvaluationPlan(c.req.valid("param").projectId, c.req.valid("json")));

export const observeSampling: AppRouteHandler<typeof routes.observeSampling> = async (c) => {
  const { projectId, samplingId } = c.req.valid("param");
  return ok(c, await c.var.services.observations.subject(projectId, samplingId));
};

export const observeEvaluation: AppRouteHandler<typeof routes.observeEvaluation> = async (c) => {
  const { projectId, evaluationId } = c.req.valid("param");
  return ok(c, await c.var.services.observations.evaluator(projectId, evaluationId));
};
