import { ok } from "@eval-platform/eval-contracts/http";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./configs.routes.js";

function found<T>(config: T | null): T {
  if (config === null) throw new HttpError("CONFIG_NOT_FOUND");
  return config;
}

export const listExecution: AppRouteHandler<typeof routes.execution.list> = async (c) =>
  ok(c, await c.var.services.configs.listExecutionConfigs());

export const createExecution: AppRouteHandler<typeof routes.execution.create> = async (c) =>
  ok(c, await c.var.services.configs.createExecutionConfig(c.req.valid("json")), 201);

export const getExecution: AppRouteHandler<typeof routes.execution.get> = async (c) =>
  ok(c, found(await c.var.services.configs.getExecutionConfig(c.req.valid("param").configId)));

export const replaceExecution: AppRouteHandler<typeof routes.execution.replace> = async (c) =>
  ok(c, await c.var.services.configs.updateExecutionConfig(c.req.valid("param").configId, c.req.valid("json")));

export const listEvaluation: AppRouteHandler<typeof routes.evaluation.list> = async (c) =>
  ok(c, await c.var.services.configs.listEvaluationConfigs());

export const createEvaluation: AppRouteHandler<typeof routes.evaluation.create> = async (c) =>
  ok(c, await c.var.services.configs.createEvaluationConfig(c.req.valid("json")), 201);

export const getEvaluation: AppRouteHandler<typeof routes.evaluation.get> = async (c) =>
  ok(c, found(await c.var.services.configs.getEvaluationConfig(c.req.valid("param").configId)));

export const replaceEvaluation: AppRouteHandler<typeof routes.evaluation.replace> = async (c) =>
  ok(c, await c.var.services.configs.updateEvaluationConfig(c.req.valid("param").configId, c.req.valid("json")));

export const listPipeline: AppRouteHandler<typeof routes.pipeline.list> = async (c) =>
  ok(c, await c.var.services.configs.listPipelineConfigs());

export const createPipeline: AppRouteHandler<typeof routes.pipeline.create> = async (c) =>
  ok(c, await c.var.services.configs.createPipelineConfig(c.req.valid("json")), 201);

export const getPipeline: AppRouteHandler<typeof routes.pipeline.get> = async (c) =>
  ok(c, found(await c.var.services.configs.getPipelineConfig(c.req.valid("param").configId)));

export const replacePipeline: AppRouteHandler<typeof routes.pipeline.replace> = async (c) =>
  ok(c, await c.var.services.configs.updatePipelineConfig(c.req.valid("param").configId, c.req.valid("json")));
