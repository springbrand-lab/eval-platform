import { ok } from "@eval-platform/eval-contracts/http";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { fileResponse } from "../../lib/file-response.js";
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

export const evaluationOutputSchema: AppRouteHandler<typeof routes.evaluationOutputSchema> = async (c) =>
  ok(c, await c.var.services.projects.getEvaluationOutputSchema(c.req.valid("param").projectId));

export const evaluationResults: AppRouteHandler<typeof routes.evaluationResults> = async (c) => {
  const { projectId } = c.req.valid("param");
  const body = await c.var.services.projectResultsExport.open(projectId, c.req.raw.signal);
  const response = fileResponse({ body, contentType: "application/zip", contentLength: null });
  response.headers.set("Content-Disposition", `attachment; filename="project-${encodeURIComponent(projectId)}-evaluation-results.zip"`);
  return response as never;
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

async function observedChat(c: Parameters<AppRouteHandler<typeof routes.observeChat>>[0] | Parameters<AppRouteHandler<typeof routes.observeFile>>[0],
  projectId: string, kind: "samplings" | "evaluations", id: string) {
  const observations = c.var.services.observations;
  const ref = kind === "samplings" ? await observations.subject(projectId, id) : await observations.evaluator(projectId, id);
  if (!ref.chatId) throw new HttpError("EVAL_SP_NOT_FOUND", "The Agent has not started yet");
  return { ownerUserId: ref.ownerUserId, chatId: ref.chatId };
}

export const observeChat: AppRouteHandler<typeof routes.observeChat> = async (c) => {
  const { projectId, kind, id, part } = c.req.valid("param");
  const chat = await observedChat(c, projectId, kind, id);
  const observation = c.env.observation;
  if (part === "messages") return ok(c, await observation.messages(chat));
  if (part === "tree") return ok(c, await observation.tree(chat));
  const { limit, beforeSeq } = c.req.valid("query");
  return ok(c, await observation.trajectory(chat, {
    ...(limit === undefined ? {} : { limit }),
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
  }));
};

/** Bytes go out as an attachment under a sandbox CSP, so a Workspace file never runs in Eval's origin. */
export const observeFile: AppRouteHandler<typeof routes.observeFile> = async (c) => {
  const { projectId, kind, id } = c.req.valid("param");
  const chat = await observedChat(c, projectId, kind, id);
  const file = await c.env.observation.file(chat, c.req.valid("query").path);
  return fileResponse(file) as never;
};

export const resourceSnapshot: AppRouteHandler<typeof routes.resourceSnapshot> = async (c) => {
  const { projectId, kind, id, attemptId } = c.req.valid("param");
  const body = await c.var.services.resourceSnapshots.open(projectId, kind === "samplings" ? "execution" : "evaluation", id, attemptId);
  if (!body) throw new HttpError("RESOURCE_SNAPSHOT_NOT_FOUND");
  return fileResponse({ body, contentType: "application/json", contentLength: null }) as never;
};
