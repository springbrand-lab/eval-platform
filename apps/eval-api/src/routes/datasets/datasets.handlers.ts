import { dataInputSchema, parsePromptDatasetUpload } from "@eval-platform/eval-dataset";
import { ok } from "@eval-platform/eval-contracts/http";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { readTextBody } from "../../lib/request-body.js";
import type { AppRouteHandler } from "../../lib/types.js";
import { DATASET_DOCUMENT_BYTES } from "../../limits.js";
import type * as routes from "./datasets.routes.js";

const DOCUMENT_MEDIA_TYPES = { json: "application/json; charset=utf-8", yaml: "application/yaml; charset=utf-8" } as const;

export const list: AppRouteHandler<typeof routes.list> = async (c) =>
  ok(c, await c.var.services.datasets.listDatasets());

export const create: AppRouteHandler<typeof routes.create> = async (c) =>
  ok(c, await c.var.services.datasets.createDataset(c.req.valid("json")), 201);

export const importDocument: AppRouteHandler<typeof routes.importDocument> = async (c) => {
  const source = await readTextBody(c.req.raw, DATASET_DOCUMENT_BYTES);
  return ok(c, await c.var.services.datasets.importDataset(source, c.req.valid("query").format), 201);
};

export const importPrompt: AppRouteHandler<typeof routes.importPrompt> = async (c) =>
  ok(c, await c.var.services.datasets.importPromptDataset(c.req.valid("json")), 201);

export const get: AppRouteHandler<typeof routes.get> = async (c) => {
  const dataset = await c.var.services.datasets.getDataset(c.req.valid("param").datasetId);
  if (!dataset) throw new HttpError("DATASET_NOT_FOUND");
  return ok(c, dataset);
};

export const replace: AppRouteHandler<typeof routes.replace> = async (c) =>
  ok(c, await c.var.services.datasets.updateDataset(c.req.valid("param").datasetId, c.req.valid("json")));

export const remove: AppRouteHandler<typeof routes.remove> = async (c) => {
  await c.var.services.datasets.deleteDataset(c.req.valid("param").datasetId);
  return c.body(null, 204);
};

export const listData: AppRouteHandler<typeof routes.listData> = async (c) =>
  ok(c, await c.var.services.datasets.listData(c.req.valid("param").datasetId));

export const attachData: AppRouteHandler<typeof routes.attachData> = async (c) => {
  await c.var.services.datasets.attachData(c.req.valid("param").datasetId, c.req.valid("json").dataIds);
  return c.body(null, 204);
};

export const detachData: AppRouteHandler<typeof routes.detachData> = async (c) => {
  await c.var.services.datasets.detachData(c.req.valid("param").datasetId, c.req.valid("json").dataIds);
  return c.body(null, 204);
};

export const exportDocument: AppRouteHandler<typeof routes.exportDocument> = async (c) => {
  const { format } = c.req.valid("query");
  const document = await c.var.services.datasets.exportDataset(c.req.valid("param").datasetId, format);
  return c.body(document, 200, { "Content-Type": DOCUMENT_MEDIA_TYPES[format] });
};

export const importData: AppRouteHandler<typeof routes.importData> = async (c) => {
  const document = parsePromptDatasetUpload({ ...c.req.valid("json"), name: "import", description: "import" });
  return ok(c, await c.var.services.datasets.addData(c.req.valid("param").datasetId, dataInputSchema.array().parse(document.data)), 201);
};
