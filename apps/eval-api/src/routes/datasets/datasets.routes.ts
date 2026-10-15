import { createRoute, z } from "@hono/zod-openapi";
import {
  datasetInputSchema,
  platformIdSchema,
  promptDatasetUploadSchema,
  type Data,
  type Dataset,
  type DatasetSnapshot,
} from "@eval-platform/eval-dataset";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { jsonBody } from "../../lib/request-body.js";
import { JSON_BODY_BYTES, PROMPT_DATASET_FILE_BYTES, PROMPT_IMPORT_BODY_BYTES } from "../../limits.js";
import {
  bodyErrorResponses,
  conflictResponse,
  deletedResponse,
  errorResponses,
  jsonBodyContent,
  notFoundResponse,
} from "../schemas.js";

const datasetSchema = z.custom<Dataset>();
const snapshotSchema = z.custom<DatasetSnapshot>();
const params = z.object({ datasetId: platformIdSchema });
const formatQuery = z.strictObject({ format: z.enum(["json", "yaml"]) });
const membershipBody = jsonBodyContent(z.strictObject({ dataIds: z.array(platformIdSchema) }));

export const list = createRoute({
  method: "get",
  path: "/",
  tags: ["Dataset"],
  summary: "List the user's Datasets",
  responses: {
    200: jsonContent(responseSchema(z.array(datasetSchema).readonly()), "Datasets"),
    ...errorResponses,
  },
});

export const create = createRoute({
  method: "post",
  path: "/",
  tags: ["Dataset"],
  summary: "Create a Dataset",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { body: jsonBodyContent(datasetInputSchema) },
  responses: {
    201: jsonContent(responseSchema(datasetSchema), "Created Dataset"),
    ...bodyErrorResponses,
  },
});

export const importDocument = createRoute({
  method: "post",
  path: "/import",
  tags: ["Dataset"],
  summary: "Import a whole Dataset document; the body is the raw JSON or YAML text",
  request: {
    query: formatQuery,
    body: { required: true, content: { "text/plain": { schema: z.string() }, "application/yaml": { schema: z.string() } } },
  },
  responses: {
    201: jsonContent(responseSchema(snapshotSchema), "Imported Dataset"),
    ...bodyErrorResponses,
    ...conflictResponse,
  },
});

export const importPrompt = createRoute({
  method: "post",
  path: "/prompt-import",
  tags: ["Dataset"],
  summary: "Create a Prompt Dataset from metadata and a JSON or JSONL Data file",
  middleware: [jsonBody(PROMPT_IMPORT_BODY_BYTES)],
  request: {
    body: jsonBodyContent(promptDatasetUploadSchema.refine(
      (upload) => Buffer.byteLength(upload.content, "utf8") <= PROMPT_DATASET_FILE_BYTES,
      { path: ["content"], message: `must be at most ${PROMPT_DATASET_FILE_BYTES} bytes` },
    )),
  },
  responses: {
    201: jsonContent(responseSchema(snapshotSchema), "Imported Dataset"),
    ...bodyErrorResponses,
    ...conflictResponse,
  },
});

export const get = createRoute({
  method: "get",
  path: "/{datasetId}",
  tags: ["Dataset"],
  summary: "Get a Dataset",
  request: { params },
  responses: {
    200: jsonContent(responseSchema(datasetSchema), "Dataset"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const replace = createRoute({
  method: "put",
  path: "/{datasetId}",
  tags: ["Dataset"],
  summary: "Replace a Dataset's editable fields",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { params, body: jsonBodyContent(datasetInputSchema) },
  responses: {
    200: jsonContent(responseSchema(datasetSchema), "Dataset"),
    ...bodyErrorResponses,
    ...notFoundResponse,
  },
});

export const remove = createRoute({
  method: "delete",
  path: "/{datasetId}",
  tags: ["Dataset"],
  summary: "Soft-delete an unreferenced Dataset; deleting an absent Dataset succeeds",
  request: { params },
  responses: {
    ...deletedResponse,
    ...errorResponses,
    ...conflictResponse,
  },
});

export const listData = createRoute({
  method: "get",
  path: "/{datasetId}/data",
  tags: ["Dataset"],
  summary: "List the Dataset's Data",
  request: { params },
  responses: {
    200: jsonContent(responseSchema(z.array(z.custom<Data>()).readonly()), "Data"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const attachData = createRoute({
  method: "post",
  path: "/{datasetId}/data",
  tags: ["Dataset"],
  summary: "Add Data to the Dataset",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { params, body: membershipBody },
  responses: {
    204: { description: "Attached" },
    ...bodyErrorResponses,
    ...notFoundResponse,
  },
});

export const detachData = createRoute({
  method: "delete",
  path: "/{datasetId}/data",
  tags: ["Dataset"],
  summary: "Remove Data from the Dataset",
  middleware: [jsonBody(JSON_BODY_BYTES)],
  request: { params, body: membershipBody },
  responses: {
    204: { description: "Detached" },
    ...bodyErrorResponses,
    ...notFoundResponse,
  },
});

export const exportDocument = createRoute({
  method: "get",
  path: "/{datasetId}/export",
  tags: ["Dataset"],
  summary: "Export the whole Dataset document",
  request: { params, query: formatQuery },
  responses: {
    200: {
      description: "Dataset document",
      content: { "application/json": { schema: z.string() }, "application/yaml": { schema: z.string() } },
    },
    ...errorResponses,
    ...notFoundResponse,
  },
});
