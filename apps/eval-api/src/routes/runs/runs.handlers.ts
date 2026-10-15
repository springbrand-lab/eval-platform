import { ok } from "@eval-platform/eval-contracts/http";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { RunTargetsTooLargeError } from "../../db/errors.js";
import type { AppRouteHandler, OwnerServices } from "../../lib/types.js";
import { RUN_TARGET_IDS } from "../../limits.js";
import type * as routes from "./runs.routes.js";

async function requireProject(services: OwnerServices, projectId: string): Promise<void> {
  if (!await services.projects.exists(projectId)) throw new HttpError("PROJECT_NOT_FOUND");
}

async function requireProjectRun(services: OwnerServices, projectId: string, runId: string) {
  const view = await services.projectRuns.readRun(projectId, runId);
  if (!view) throw new HttpError("RUN_NOT_FOUND");
  return view;
}

export const previewRun: AppRouteHandler<typeof routes.previewRun> = async (c) => {
  const preview = await c.var.services.admission.preview({ projectId: c.req.valid("param").projectId, ...c.req.valid("json") });
  if (preview.targets.projectSampleIds.length + preview.targets.samplingIds.length > RUN_TARGET_IDS) {
    throw new RunTargetsTooLargeError();
  }
  return ok(c, preview);
};

export const submitRun: AppRouteHandler<typeof routes.submitRun> = async (c) =>
  ok(c, await c.var.services.admission.submit({ projectId: c.req.valid("param").projectId, ...c.req.valid("json") }), 202);

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

export const getProjectRun: AppRouteHandler<typeof routes.getProjectRun> = async (c) => {
  const { projectId, runId } = c.req.valid("param");
  return ok(c, { run: (await requireProjectRun(c.var.services, projectId, runId)).run });
};

export const listProjectRunEvaluations: AppRouteHandler<typeof routes.listProjectRunEvaluations> = async (c) => {
  const { projectId, runId } = c.req.valid("param");
  return ok(c, { evaluations: (await requireProjectRun(c.var.services, projectId, runId)).evaluations });
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
