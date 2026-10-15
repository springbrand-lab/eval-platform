import type { Project } from "@eval-platform/eval-contracts";
import { ok } from "@eval-platform/eval-contracts/http";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./projects.routes.js";

function publicProject(project: Project): Project {
  return {
    projectId: project.projectId,
    ownerUserId: project.ownerUserId,
    name: project.name,
    sourceBranch: project.sourceBranch,
    ...(project.evaluationOutputSchemaId === undefined ? {} : { evaluationOutputSchemaId: project.evaluationOutputSchemaId }),
    ...(project.initialLaunch === undefined ? {} : { initialLaunch: project.initialLaunch }),
  };
}

export const list: AppRouteHandler<typeof routes.list> = async (c) =>
  ok(c, (await c.var.services.catalog.listProjects()).map(publicProject));

export const create: AppRouteHandler<typeof routes.create> = async (c) =>
  ok(c, publicProject(await c.var.services.catalog.createProject(c.req.valid("json"))), 201);

export const get: AppRouteHandler<typeof routes.get> = async (c) => {
  const project = await c.var.services.catalog.getProject(c.req.valid("param").projectId);
  if (!project) throw new HttpError("PROJECT_NOT_FOUND");
  return ok(c, publicProject(project));
};

export const bindOutputSchema: AppRouteHandler<typeof routes.bindOutputSchema> = async (c) => {
  const { projectId } = c.req.valid("param");
  const { outputSchemaId } = c.req.valid("json");
  return ok(c, publicProject(await c.var.services.catalog.bindEvaluationOutputSchema(projectId, outputSchemaId)));
};
