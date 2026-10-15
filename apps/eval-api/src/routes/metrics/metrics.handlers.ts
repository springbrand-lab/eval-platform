import { ok } from "@eval-platform/eval-contracts/http";
import type { MetricsScope } from "@eval-platform/eval-metrics";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./metrics.routes.js";

function scope(projectId: string, runIds: readonly string[] | undefined): MetricsScope {
  return runIds === undefined ? { projectId } : { projectId, runIds };
}

export const projectOverview: AppRouteHandler<typeof routes.projectOverview> = async (c) => {
  const { projectId } = c.req.valid("param");
  return ok(c, await c.var.services.metrics.getProjectOverview(scope(projectId, c.req.valid("query").runId)));
};

export const datasetOverview: AppRouteHandler<typeof routes.datasetOverview> = async (c) => {
  const { projectId, datasetId } = c.req.valid("param");
  return ok(c, await c.var.services.metrics.getDatasetOverview({ ...scope(projectId, c.req.valid("query").runId), datasetId }));
};

export const sampleOverview: AppRouteHandler<typeof routes.sampleOverview> = async (c) => {
  const { projectId, projectSampleId } = c.req.valid("param");
  return ok(c, await c.var.services.metrics.getSampleOverview({ ...scope(projectId, c.req.valid("query").runId), projectSampleId }));
};

export const samplingDetail: AppRouteHandler<typeof routes.samplingDetail> = async (c) => {
  const { projectId, samplingId } = c.req.valid("param");
  return ok(c, await c.var.services.metrics.getSamplingDetail({ ...scope(projectId, c.req.valid("query").runId), samplingId }));
};
