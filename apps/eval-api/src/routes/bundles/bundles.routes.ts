import { createRoute, z } from "@hono/zod-openapi";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import { evalInitialContextSchema } from "@springbrand/eval-harness";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import type { BundleRecord, MaterialRecord, SessionRecord } from "../../db/resource-catalog.js";
import { jsonBody } from "../../lib/request-body.js";
import { MATERIAL_BODY_BYTES, METADATA_BODY_BYTES, SESSION_BODY_BYTES } from "../../limits.js";
import { materialFilesSchema } from "../../sp/bundle-directory.js";
import {
  bodyErrorResponses,
  catalogLabelSchema,
  catalogMetadataPatchSchema,
  conflictResponse,
  deletedResponse,
  errorResponses,
  jsonBodyContent,
  notFoundResponse,
} from "../schemas.js";

const bundleSchema = z.custom<BundleRecord>();
const materialSchema = z.custom<MaterialRecord>();
const sessionSchema = z.custom<SessionRecord>();
const bundleParams = z.object({ bundleId: platformIdSchema });
const materialParams = bundleParams.extend({ materialId: platformIdSchema });
const sessionParams = bundleParams.extend({ sessionId: platformIdSchema });
const metadata = { name: catalogLabelSchema, description: catalogLabelSchema };
const metadataMiddleware = [jsonBody(METADATA_BODY_BYTES)];
const metadataPatchBody = jsonBodyContent(catalogMetadataPatchSchema);

export const listBundles = createRoute({
  method: "get",
  path: "/",
  tags: ["Bundle"],
  summary: "List the user's Bundles",
  responses: {
    200: jsonContent(responseSchema(z.array(bundleSchema).readonly()), "Bundles"),
    ...errorResponses,
  },
});

export const createBundle = createRoute({
  method: "post",
  path: "/",
  tags: ["Bundle"],
  summary: "Create a Bundle",
  middleware: metadataMiddleware,
  request: { body: jsonBodyContent(z.strictObject(metadata)) },
  responses: {
    201: jsonContent(responseSchema(bundleSchema), "Created Bundle"),
    ...bodyErrorResponses,
  },
});

export const getBundle = createRoute({
  method: "get",
  path: "/{bundleId}",
  tags: ["Bundle"],
  summary: "Get a Bundle",
  request: { params: bundleParams },
  responses: {
    200: jsonContent(responseSchema(bundleSchema), "Bundle"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const updateBundle = createRoute({
  method: "patch",
  path: "/{bundleId}",
  tags: ["Bundle"],
  summary: "Edit a Bundle's name or description",
  middleware: metadataMiddleware,
  request: { params: bundleParams, body: metadataPatchBody },
  responses: {
    200: jsonContent(responseSchema(bundleSchema), "Bundle"),
    ...bodyErrorResponses,
    ...notFoundResponse,
  },
});

export const deleteBundle = createRoute({
  method: "delete",
  path: "/{bundleId}",
  tags: ["Bundle"],
  summary: "Soft-delete a Bundle that no Data references",
  request: { params: bundleParams },
  responses: {
    ...deletedResponse,
    ...errorResponses,
    ...notFoundResponse,
    ...conflictResponse,
  },
});

export const listMaterials = createRoute({
  method: "get",
  path: "/{bundleId}/materials",
  tags: ["Bundle"],
  summary: "List the Bundle's Materials",
  request: { params: bundleParams },
  responses: {
    200: jsonContent(responseSchema(z.array(materialSchema).readonly()), "Materials"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const createMaterial = createRoute({
  method: "post",
  path: "/{bundleId}/materials",
  tags: ["Bundle"],
  summary: "Upload a Material file set",
  middleware: [jsonBody(MATERIAL_BODY_BYTES)],
  request: {
    params: bundleParams,
    body: jsonBodyContent(z.strictObject({ ...metadata, files: materialFilesSchema })),
  },
  responses: {
    201: jsonContent(responseSchema(materialSchema), "Created Material"),
    ...bodyErrorResponses,
    ...notFoundResponse,
    ...conflictResponse,
  },
});

export const getMaterial = createRoute({
  method: "get",
  path: "/{bundleId}/materials/{materialId}",
  tags: ["Bundle"],
  summary: "Get a Material",
  request: { params: materialParams },
  responses: {
    200: jsonContent(responseSchema(materialSchema), "Material"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const updateMaterial = createRoute({
  method: "patch",
  path: "/{bundleId}/materials/{materialId}",
  tags: ["Bundle"],
  summary: "Edit a Material's name or description",
  middleware: metadataMiddleware,
  request: { params: materialParams, body: metadataPatchBody },
  responses: {
    200: jsonContent(responseSchema(materialSchema), "Material"),
    ...bodyErrorResponses,
    ...notFoundResponse,
  },
});

export const deleteMaterial = createRoute({
  method: "delete",
  path: "/{bundleId}/materials/{materialId}",
  tags: ["Bundle"],
  summary: "Soft-delete a Material that no Data references",
  request: { params: materialParams },
  responses: {
    ...deletedResponse,
    ...errorResponses,
    ...notFoundResponse,
    ...conflictResponse,
  },
});

export const listSessions = createRoute({
  method: "get",
  path: "/{bundleId}/sessions",
  tags: ["Bundle"],
  summary: "List the Bundle's Sessions",
  request: { params: bundleParams },
  responses: {
    200: jsonContent(responseSchema(z.array(sessionSchema).readonly()), "Sessions"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const createSession = createRoute({
  method: "post",
  path: "/{bundleId}/sessions",
  tags: ["Bundle"],
  summary: "Upload an initial Session file",
  middleware: [jsonBody(SESSION_BODY_BYTES)],
  request: {
    params: bundleParams,
    body: jsonBodyContent(evalInitialContextSchema.extend(metadata)),
  },
  responses: {
    201: jsonContent(responseSchema(sessionSchema), "Created Session"),
    ...bodyErrorResponses,
    ...notFoundResponse,
    ...conflictResponse,
  },
});

export const getSession = createRoute({
  method: "get",
  path: "/{bundleId}/sessions/{sessionId}",
  tags: ["Bundle"],
  summary: "Get a Session",
  request: { params: sessionParams },
  responses: {
    200: jsonContent(responseSchema(sessionSchema), "Session"),
    ...errorResponses,
    ...notFoundResponse,
  },
});

export const updateSession = createRoute({
  method: "patch",
  path: "/{bundleId}/sessions/{sessionId}",
  tags: ["Bundle"],
  summary: "Edit a Session's name or description",
  middleware: metadataMiddleware,
  request: { params: sessionParams, body: metadataPatchBody },
  responses: {
    200: jsonContent(responseSchema(sessionSchema), "Session"),
    ...bodyErrorResponses,
    ...notFoundResponse,
  },
});

export const deleteSession = createRoute({
  method: "delete",
  path: "/{bundleId}/sessions/{sessionId}",
  tags: ["Bundle"],
  summary: "Soft-delete a Session that no Data references",
  request: { params: sessionParams },
  responses: {
    ...deletedResponse,
    ...errorResponses,
    ...notFoundResponse,
    ...conflictResponse,
  },
});
