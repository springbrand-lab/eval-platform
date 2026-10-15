import { ok } from "@eval-platform/eval-contracts/http";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { AppRouteHandler, OwnerServices } from "../../lib/types.js";
import type * as routes from "./runs.routes.js";

async function requireProject(services: OwnerServices, projectId: string): Promise<void> {
  if (!await services.catalog.getProject(projectId)) throw new HttpError("PROJECT_NOT_FOUND");
}

async function requireProjectRun(services: OwnerServices, projectId: string, runId: string) {
  const view = await services.projectRuns.readRun(projectId, runId);
  if (!view) throw new HttpError("RUN_NOT_FOUND");
  return view;
}

export const startExecution: AppRouteHandler<typeof routes.startExecution> = async (c) =>
  ok(c, await c.var.services.admission.start(c.req.valid("json")), 201);

export const startPipeline: AppRouteHandler<typeof routes.startPipeline> = async (c) =>
  ok(c, await c.var.services.admission.pipeline(c.req.valid("json")), 201);

export const evaluate: AppRouteHandler<typeof routes.evaluate> = async (c) => {
  const { projectId } = c.req.valid("param");
  await requireProject(c.var.services, projectId);
  return ok(c, await c.var.services.admission.evaluate({ projectId, ...c.req.valid("json") }), 202);
};

export const getRun: AppRouteHandler<typeof routes.getRun> = async (c) =>
  ok(c, await c.var.services.results.getRun(c.req.valid("param").runId));

export const getCurrentRun: AppRouteHandler<typeof routes.getCurrentRun> = async (c) => {
  const { projectId } = c.req.valid("param");
  await requireProject(c.var.services, projectId);
  return ok(c, { run: await c.var.services.projectRuns.getCurrentRun(projectId) });
};

export const stopRun: AppRouteHandler<typeof routes.stopRun> = async (c) => {
  const { projectId, runId } = c.req.valid("param");
  const stopped = await c.var.services.projectRuns.stopRun(projectId, runId);
  if (!stopped) throw new HttpError("RUN_NOT_FOUND");
  return ok(c, stopped, 202);
};

export const syncRunScores: AppRouteHandler<typeof routes.syncRunScores> = async (c) => {
  const { projectId, runId } = c.req.valid("param");
  const scores = c.var.services.scores;
  if (!scores) throw new HttpError("SCORE_SYNC_UNCONFIGURED");
  const summary = await scores.syncRun(projectId, runId);
  if (!summary) throw new HttpError("RUN_NOT_FOUND");
  return ok(c, summary);
};

export const getProjectRun: AppRouteHandler<typeof routes.getProjectRun> = async (c) => {
  const { projectId, runId } = c.req.valid("param");
  return ok(c, { run: (await requireProjectRun(c.var.services, projectId, runId)).run });
};

export const listProjectRunEvaluations: AppRouteHandler<typeof routes.listProjectRunEvaluations> = async (c) => {
  const { projectId, runId } = c.req.valid("param");
  return ok(c, { evaluations: (await requireProjectRun(c.var.services, projectId, runId)).evaluations });
};

export const listSuccessfulSamplings: AppRouteHandler<typeof routes.listSuccessfulSamplings> = async (c) => {
  const { projectId } = c.req.valid("param");
  await requireProject(c.var.services, projectId);
  return ok(c, await c.var.services.catalog.listSuccessfulSamplings(projectId, c.req.valid("query")));
};

export const selectSuccessfulSamplingIds: AppRouteHandler<typeof routes.selectSuccessfulSamplingIds> = async (c) => {
  const { projectId } = c.req.valid("param");
  await requireProject(c.var.services, projectId);
  return ok(c, { samplingIds: await c.var.services.catalog.selectAllSuccessfulSamplingIds(projectId, c.req.valid("query")) });
};

export const getSampling: AppRouteHandler<typeof routes.getSampling> = async (c) =>
  ok(c, await c.var.services.results.getSampling(c.req.valid("param").samplingId));

export const listSamplingEvaluations: AppRouteHandler<typeof routes.listSamplingEvaluations> = async (c) => {
  const { samplingId } = c.req.valid("param");
  await c.var.services.results.getSampling(samplingId);
  return ok(c, await c.var.services.results.listEvaluations(samplingId));
};

export const getEvaluation: AppRouteHandler<typeof routes.getEvaluation> = async (c) =>
  ok(c, await c.var.services.results.getEvaluation(c.req.valid("param").evaluationId));
