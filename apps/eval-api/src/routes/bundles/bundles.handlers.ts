import { ok } from "@eval-platform/eval-contracts/http";
import type { AppRouteHandler } from "../../lib/types.js";
import type * as routes from "./bundles.routes.js";

export const listBundles: AppRouteHandler<typeof routes.listBundles> = async (c) =>
  ok(c, await c.var.services.resources.listBundles());

export const createBundle: AppRouteHandler<typeof routes.createBundle> = async (c) =>
  ok(c, await c.var.services.resources.createBundle(c.req.valid("json")), 201);

export const getBundle: AppRouteHandler<typeof routes.getBundle> = async (c) =>
  ok(c, await c.var.services.resources.getBundle(c.req.valid("param").bundleId));

export const updateBundle: AppRouteHandler<typeof routes.updateBundle> = async (c) =>
  ok(c, await c.var.services.resources.updateBundle(c.req.valid("param").bundleId, c.req.valid("json")));

export const deleteBundle: AppRouteHandler<typeof routes.deleteBundle> = async (c) => {
  await c.var.services.resources.deleteBundle(c.req.valid("param").bundleId);
  return c.body(null, 204);
};

export const listMaterials: AppRouteHandler<typeof routes.listMaterials> = async (c) =>
  ok(c, await c.var.services.resources.listMaterials(c.req.valid("param").bundleId));

export const createMaterial: AppRouteHandler<typeof routes.createMaterial> = async (c) =>
  ok(c, await c.var.services.resources.createMaterial(c.req.valid("param").bundleId, c.req.valid("json")), 201);

export const getMaterial: AppRouteHandler<typeof routes.getMaterial> = async (c) => {
  const { bundleId, materialId } = c.req.valid("param");
  return ok(c, await c.var.services.resources.getMaterial(bundleId, materialId));
};

export const updateMaterial: AppRouteHandler<typeof routes.updateMaterial> = async (c) => {
  const { bundleId, materialId } = c.req.valid("param");
  return ok(c, await c.var.services.resources.updateMaterial(bundleId, materialId, c.req.valid("json")));
};

export const deleteMaterial: AppRouteHandler<typeof routes.deleteMaterial> = async (c) => {
  const { bundleId, materialId } = c.req.valid("param");
  await c.var.services.resources.deleteMaterial(bundleId, materialId);
  return c.body(null, 204);
};

export const listSessions: AppRouteHandler<typeof routes.listSessions> = async (c) =>
  ok(c, await c.var.services.resources.listSessions(c.req.valid("param").bundleId));

export const createSession: AppRouteHandler<typeof routes.createSession> = async (c) =>
  ok(c, await c.var.services.resources.createSession(c.req.valid("param").bundleId, c.req.valid("json")), 201);

export const getSession: AppRouteHandler<typeof routes.getSession> = async (c) => {
  const { bundleId, sessionId } = c.req.valid("param");
  return ok(c, await c.var.services.resources.getSession(bundleId, sessionId));
};

export const updateSession: AppRouteHandler<typeof routes.updateSession> = async (c) => {
  const { bundleId, sessionId } = c.req.valid("param");
  return ok(c, await c.var.services.resources.updateSession(bundleId, sessionId, c.req.valid("json")));
};

export const deleteSession: AppRouteHandler<typeof routes.deleteSession> = async (c) => {
  const { bundleId, sessionId } = c.req.valid("param");
  await c.var.services.resources.deleteSession(bundleId, sessionId);
  return c.body(null, 204);
};
