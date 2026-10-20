import { createRoute, z } from "@hono/zod-openapi";
import { ok } from "@eval-platform/eval-contracts/http";
import { initialResourceFileSchema } from "@eval-platform/eval-contracts";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import { responseSchema } from "@springbrand/http/catalog";
import { jsonContent } from "stoker/openapi/helpers";
import { catalogLabelSchema, catalogMetadataPatchSchema } from "../db/catalog-metadata.js";
import type { BundleCatalog, BundleImport, BundleRecord, CatalogLabels, MaterialRecord, SessionRecord } from "../db/resource-catalog.js";
import { createRouter } from "../lib/create-app.js";
import { jsonBody, multipartBody } from "../lib/request-body.js";
import type { OwnerServices } from "../lib/types.js";
import { fileResponse } from "../lib/file-response.js";
import { METADATA_BODY_BYTES, ZIP_BODY_BYTES } from "../limits.js";
import {
  bodyErrorResponses,
  deletedResponse,
  errorResponses,
  fileSchema,
  jsonBodyContent,
  multipartBodyContent,
  notFoundResponse,
} from "./schemas.js";

type ResourceRecord = MaterialRecord | SessionRecord;

export const metadata = { name: catalogLabelSchema, description: catalogLabelSchema };

/** One Bundle kind: its OpenAPI names, resource body, catalog and ZIP layout. */
interface BundleRouteKind<R extends ResourceRecord, C, Z extends { readonly source: string }, Imported> {
  readonly tag: "Material Bundle" | "Session Bundle";
  readonly resource: "Material" | "Session";
  readonly segment: "materials" | "sessions";
  readonly idParam: "materialId" | "sessionId";
  readonly body: z.ZodType<CatalogLabels & C>;
  readonly bodyBytes: number;
  readonly catalog: (services: OwnerServices) => BundleCatalog<R, CatalogLabels & C>;
  readonly readZip: (bytes: Uint8Array) => Promise<readonly Z[]>;
  /** A ZIP resource's content; its name is its `source` and its description is the target Bundle's. */
  readonly content: (resource: Z) => C;
  readonly imported: (source: string, record: R) => Imported;
}

/** The routes, handlers and router of one Bundle kind: its Bundles and the resources inside them. */
export function bundleRouter<R extends ResourceRecord, C, Z extends { readonly source: string }, Imported>(
  kind: BundleRouteKind<R, C, Z, Imported>,
) {
  const { tag, resource, segment, idParam } = kind;
  const bundleSchema = z.custom<BundleRecord>();
  const importSchema = z.custom<BundleImport<Imported>>();
  const resourceSchema = z.custom<ResourceRecord>();
  const bundleParams = z.object({ bundleId: platformIdSchema });
  const resourceParams = bundleParams.extend({ [idParam]: platformIdSchema });
  const metadataMiddleware = [jsonBody(METADATA_BODY_BYTES)];
  const metadataPatchBody = jsonBodyContent(catalogMetadataPatchSchema);
  const zipMiddleware = [multipartBody(ZIP_BODY_BYTES)];
  const resourcesPath = `/{bundleId}/${segment}` as const;
  const resourcePath = `${resourcesPath}/{${idParam}}` as const;
  const fileErrorResponses = {
    ...errorResponses,
    ...notFoundResponse,
  } as const;

  const resourceRef = (params: Readonly<Record<string, string | undefined>>) => [params.bundleId!, params[idParam]!] as const;
  const readZip = async (zip: File | undefined) => zip ? kind.readZip(new Uint8Array(await zip.arrayBuffer())) : [];
  const inputs = (resources: readonly Z[], description: string) =>
    resources.map((item) => ({ name: item.source, description, ...kind.content(item) }));
  const response = (resources: readonly Z[], { bundle, imported }: BundleImport<R>): BundleImport<Imported> => ({
    bundle, imported: imported.map((record, index) => kind.imported(resources[index]!.source, record)),
  });

  const router = createRouter();
  router.openapi(createRoute({
    method: "get",
    path: "/",
    tags: [tag],
    summary: `List the user's ${tag}s`,
    responses: {
      200: jsonContent(responseSchema(z.array(bundleSchema).readonly()), `${tag}s`),
      ...errorResponses,
    },
  }), async (c) => ok(c, await kind.catalog(c.var.services).list()));

  router.openapi(createRoute({
    method: "post",
    path: "/",
    tags: [tag],
    summary: `Create a ${tag}, optionally importing a ZIP archive`,
    middleware: zipMiddleware,
    request: { body: multipartBodyContent(z.strictObject({ ...metadata, zip: fileSchema.exactOptional() })) },
    responses: {
      201: jsonContent(responseSchema(importSchema), `Created ${tag} and its imported resources`),
      ...bodyErrorResponses,
    },
  }), async (c) => {
    const { zip, ...labels } = c.req.valid("form");
    const resources = await readZip(zip);
    const created = await kind.catalog(c.var.services).create(labels, inputs(resources, labels.description));
    return ok(c, response(resources, created), 201);
  });

  router.openapi(createRoute({
    method: "get",
    path: "/{bundleId}",
    tags: [tag],
    summary: `Get a ${tag}`,
    request: { params: bundleParams },
    responses: {
      200: jsonContent(responseSchema(bundleSchema), tag),
      ...errorResponses,
      ...notFoundResponse,
    },
  }), async (c) => ok(c, await kind.catalog(c.var.services).get(c.req.valid("param").bundleId)));

  router.openapi(createRoute({
    method: "patch",
    path: "/{bundleId}",
    tags: [tag],
    summary: `Edit a ${tag}'s name or description`,
    middleware: metadataMiddleware,
    request: { params: bundleParams, body: metadataPatchBody },
    responses: {
      200: jsonContent(responseSchema(bundleSchema), tag),
      ...bodyErrorResponses,
      ...notFoundResponse,
    },
  }), async (c) => ok(c, await kind.catalog(c.var.services).update(c.req.valid("param").bundleId, c.req.valid("json"))));

  router.openapi(createRoute({
    method: "delete",
    path: "/{bundleId}",
    tags: [tag],
    summary: `Soft-delete a ${tag}; existing Data and Projects keep their references`,
    request: { params: bundleParams },
    responses: {
      ...deletedResponse,
      ...errorResponses,
      ...notFoundResponse,
    },
  }), async (c) => {
    await kind.catalog(c.var.services).delete(c.req.valid("param").bundleId);
    return c.body(null, 204);
  });

  router.openapi(createRoute({
    method: "post",
    path: "/{bundleId}/import",
    tags: [tag],
    summary: `Import a ZIP archive into a ${tag}`,
    middleware: zipMiddleware,
    request: { params: bundleParams, body: multipartBodyContent(z.strictObject({ zip: fileSchema })) },
    responses: {
      201: jsonContent(responseSchema(importSchema), `${tag} and its imported resources`),
      ...bodyErrorResponses,
      ...notFoundResponse,
    },
  }), async (c) => {
    const catalog = kind.catalog(c.var.services);
    const { bundleId, description } = await catalog.get(c.req.valid("param").bundleId);
    const resources = await readZip(c.req.valid("form").zip);
    return ok(c, response(resources, await catalog.import(bundleId, inputs(resources, description))), 201);
  });

  router.openapi(createRoute({
    method: "get",
    path: resourcesPath,
    tags: [tag],
    summary: `List the ${tag}'s ${resource}s`,
    request: { params: bundleParams },
    responses: {
      200: jsonContent(responseSchema(z.array(resourceSchema).readonly()), `${resource}s`),
      ...errorResponses,
      ...notFoundResponse,
    },
  }), async (c) => ok(c, await kind.catalog(c.var.services).listResources(c.req.valid("param").bundleId)));

  router.openapi(createRoute({
    method: "post",
    path: resourcesPath,
    tags: [tag],
    summary: `Upload a ${resource}`,
    middleware: [jsonBody(kind.bodyBytes)],
    request: { params: bundleParams, body: jsonBodyContent(kind.body) },
    responses: {
      201: jsonContent(responseSchema(resourceSchema), `Created ${resource}`),
      ...bodyErrorResponses,
      ...notFoundResponse,
    },
  }), async (c) => {
    const created: ResourceRecord = await kind.catalog(c.var.services).createResource(c.req.valid("param").bundleId, c.req.valid("json"));
    return ok(c, created, 201);
  });

  router.openapi(createRoute({
    method: "get",
    path: resourcePath,
    tags: [tag],
    summary: `Get a ${resource}`,
    request: { params: resourceParams },
    responses: {
      200: jsonContent(responseSchema(resourceSchema), resource),
      ...errorResponses,
      ...notFoundResponse,
    },
  }), async (c) => {
    const record: ResourceRecord = await kind.catalog(c.var.services).getResource(...resourceRef(c.req.valid("param")));
    return ok(c, record);
  });

  router.openapi(createRoute({
    method: "get",
    path: `${resourcePath}/files`,
    tags: [tag],
    summary: `List the ${resource}'s immutable files`,
    request: { params: resourceParams },
    responses: {
      200: jsonContent(responseSchema(z.array(initialResourceFileSchema).readonly()), "Resource files"),
      ...fileErrorResponses,
    },
  }), async (c) => ok(c, await kind.catalog(c.var.services).listFiles(...resourceRef(c.req.valid("param")))));

  router.openapi(createRoute({
    method: "get",
    path: `${resourcePath}/file`,
    tags: [tag],
    summary: `Read one ${resource} file as a sandboxed attachment`,
    request: { params: resourceParams, query: z.object({ path: z.string().min(1) }) },
    responses: {
      200: { description: "Original file bytes", content: { "application/octet-stream": { schema: z.string() } } },
      ...fileErrorResponses,
    },
  }), async (c) => {
    const file = await kind.catalog(c.var.services).getFile(...resourceRef(c.req.valid("param")), c.req.valid("query").path);
    return fileResponse({ body: new Uint8Array(file.bytes), contentType: file.mediaType, contentLength: String(file.byteSize) }) as never;
  });

  router.openapi(createRoute({
    method: "patch",
    path: resourcePath,
    tags: [tag],
    summary: `Edit a ${resource}'s name or description`,
    middleware: metadataMiddleware,
    request: { params: resourceParams, body: metadataPatchBody },
    responses: {
      200: jsonContent(responseSchema(resourceSchema), resource),
      ...bodyErrorResponses,
      ...notFoundResponse,
    },
  }), async (c) => {
    const record: ResourceRecord = await kind.catalog(c.var.services)
      .updateResource(...resourceRef(c.req.valid("param")), c.req.valid("json"));
    return ok(c, record);
  });

  router.openapi(createRoute({
    method: "delete",
    path: resourcePath,
    tags: [tag],
    summary: `Soft-delete a ${resource}; existing Data and Projects keep their references`,
    request: { params: resourceParams },
    responses: {
      ...deletedResponse,
      ...errorResponses,
      ...notFoundResponse,
    },
  }), async (c) => {
    await kind.catalog(c.var.services).deleteResource(...resourceRef(c.req.valid("param")));
    return c.body(null, 204);
  });

  return router;
}
