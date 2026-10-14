import type { EvalDb } from "./db/client.js";
import { bindProjectEvaluationOutputSchema } from "./db/catalog.js";
import { createOutputSchemaCatalog, OutputSchemaNotFoundError, type CatalogMetadataPatch } from "./db/output-schemas.js";
import { createResourceCatalog } from "./db/resource-catalog.js";
import { createInitialResourceApi } from "./initial-resources.js";
import type { BundleDirectory, MaterialFile } from "./sp/bundle-directory.js";
import { parseStrictJson } from "./strict-json.js";

const BUNDLES_ROUTE = /^\/api\/bundles$/u;
const BUNDLE_ROUTE = /^\/api\/bundles\/([^/]+)$/u;
const MATERIALS_ROUTE = /^\/api\/bundles\/([^/]+)\/materials$/u;
const MATERIAL_ROUTE = /^\/api\/bundles\/([^/]+)\/materials\/([^/]+)$/u;
const SESSIONS_ROUTE = /^\/api\/bundles\/([^/]+)\/sessions$/u;
const SESSION_ROUTE = /^\/api\/bundles\/([^/]+)\/sessions\/([^/]+)$/u;
const OUTPUT_SCHEMAS_ROUTE = /^\/api\/evaluation-output-schemas$/u;
const OUTPUT_SCHEMA_ROUTE = /^\/api\/evaluation-output-schemas\/([^/]+)$/u;
const DATA_ROUTE = /^\/api\/data\/([^/]+)\/initial-resources$/u;
const PROJECT_SCHEMA_ROUTE = /^\/api\/projects\/([^/]+)\/evaluation-output-schema$/u;

function allowed(methods: string): Response {
  return new Response(null, { status: 405, headers: { Allow: methods } });
}

function onlyFields(body: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(body).some((key) => !fields.includes(key)) || fields.some((field) => !(field in body))) {
    throw new TypeError(`Expected fields: ${fields.join(", ")}`);
  }
}

/** Mount after Eval SP session authentication; ownerUserId is trusted server input. */
export function createInitialResourceHttpHandler(db: EvalDb, bundles: BundleDirectory) {
  return async (request: Request, ownerUserId: string): Promise<Response | null> => {
    const pathname = new URL(request.url).pathname;
    const bundle = BUNDLE_ROUTE.exec(pathname);
    const materials = MATERIALS_ROUTE.exec(pathname);
    const material = MATERIAL_ROUTE.exec(pathname);
    const sessions = SESSIONS_ROUTE.exec(pathname);
    const session = SESSION_ROUTE.exec(pathname);
    const outputSchema = OUTPUT_SCHEMA_ROUTE.exec(pathname);
    const selectedData = DATA_ROUTE.exec(pathname);
    const projectSchema = PROJECT_SCHEMA_ROUTE.exec(pathname);
    if (!BUNDLES_ROUTE.test(pathname) && !bundle && !materials && !material &&
      !sessions && !session && !OUTPUT_SCHEMAS_ROUTE.test(pathname) && !outputSchema &&
      !selectedData && !projectSchema) return null;

    if (BUNDLES_ROUTE.test(pathname) || bundle || materials || material || sessions || session) {
      const catalog = createResourceCatalog(db, ownerUserId, bundles);
      if (BUNDLES_ROUTE.test(pathname)) {
        if (request.method === "GET") return Response.json(await catalog.listBundles());
        if (request.method === "POST") {
          const body = await readJsonObject(request, 4_096);
          onlyFields(body, ["name", "description"]);
          return Response.json(await catalog.createBundle(body as { name: string; description: string }), { status: 201 });
        }
        return allowed("GET, POST");
      }
      const bundleId = decodeURIComponent((bundle ?? materials ?? material ?? sessions ?? session)![1]!);
      if (bundle) {
        if (request.method === "GET") return Response.json(await catalog.getBundle(bundleId));
        if (request.method === "PATCH") return Response.json(await catalog.updateBundle(bundleId,
          await readJsonObject(request, 4_096) as CatalogMetadataPatch));
        if (request.method === "DELETE") { await catalog.deleteBundle(bundleId); return new Response(null, { status: 204 }); }
        return allowed("GET, PATCH, DELETE");
      }
      if (materials) {
        if (request.method === "GET") return Response.json(await catalog.listMaterials(bundleId));
        if (request.method === "POST") {
          const body = await readJsonObject(request, 27_000_000);
          onlyFields(body, ["name", "description", "files"]);
          return Response.json(await catalog.createMaterial(bundleId, body as {
            name: string; description: string; files: MaterialFile[];
          }), { status: 201 });
        }
        return allowed("GET, POST");
      }
      if (material) {
        const materialId = decodeURIComponent(material[2]!);
        if (request.method === "GET") return Response.json(await catalog.getMaterial(bundleId, materialId));
        if (request.method === "PATCH") return Response.json(await catalog.updateMaterial(bundleId, materialId,
          await readJsonObject(request, 4_096) as CatalogMetadataPatch));
        if (request.method === "DELETE") { await catalog.deleteMaterial(bundleId, materialId); return new Response(null, { status: 204 }); }
        return allowed("GET, PATCH, DELETE");
      }
      if (sessions) {
        if (request.method === "GET") return Response.json(await catalog.listSessions(bundleId));
        if (request.method === "POST") {
          const body = await readJsonObject(request, 2_500_000);
          onlyFields(body, ["name", "description", "format", "content"]);
          return Response.json(await catalog.createSession(bundleId, body as {
            name: string; description: string; format: "json" | "jsonl"; content: string;
          }), { status: 201 });
        }
        return allowed("GET, POST");
      }
      const sessionId = decodeURIComponent(session![2]!);
      if (request.method === "GET") return Response.json(await catalog.getSession(bundleId, sessionId));
      if (request.method === "PATCH") return Response.json(await catalog.updateSession(bundleId, sessionId,
        await readJsonObject(request, 4_096) as CatalogMetadataPatch));
      if (request.method === "DELETE") { await catalog.deleteSession(bundleId, sessionId); return new Response(null, { status: 204 }); }
      return allowed("GET, PATCH, DELETE");
    }

    if (OUTPUT_SCHEMAS_ROUTE.test(pathname) || outputSchema) {
      const catalog = createOutputSchemaCatalog(db, ownerUserId);
      if (OUTPUT_SCHEMAS_ROUTE.test(pathname)) {
        if (request.method === "GET") return Response.json(await catalog.list());
        if (request.method === "POST") {
          const body = await readJsonObject(request, 1_500_000);
          onlyFields(body, ["name", "description", "content"]);
          return Response.json(await catalog.create(body as {
            name: string; description: string; content: string;
          }), { status: 201 });
        }
        return allowed("GET, POST");
      }
      const outputSchemaId = decodeURIComponent(outputSchema![1]!);
      if (request.method === "GET") {
        const selected = await catalog.get(outputSchemaId);
        if (!selected) throw new OutputSchemaNotFoundError(outputSchemaId);
        return Response.json(selected);
      }
      if (request.method === "PATCH") return Response.json(await catalog.updateMetadata(outputSchemaId,
        await readJsonObject(request, 4_096) as CatalogMetadataPatch));
      if (request.method === "DELETE") { await catalog.delete(outputSchemaId); return new Response(null, { status: 204 }); }
      return allowed("GET, PATCH, DELETE");
    }

    if (projectSchema) {
      if (request.method !== "PUT") return allowed("PUT");
      const body = await readJsonObject(request, 4_096);
      onlyFields(body, ["outputSchemaId"]);
      if (typeof body.outputSchemaId !== "string") throw new TypeError("outputSchemaId must be a UUID");
      return Response.json(await bindProjectEvaluationOutputSchema(
        db, ownerUserId, decodeURIComponent(projectSchema[1]!), body.outputSchemaId,
      ));
    }
    if (request.method !== "PATCH") return allowed("PATCH");
    const body = await readJsonObject(request, 4_096);
    return Response.json(await createInitialResourceApi(db, ownerUserId, bundles)
      .bindData(decodeURIComponent(selectedData![1]!), body));
  };
}

async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  if (!request.body) throw new TypeError("JSON body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RangeError("Request body is too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(body); }
  catch (error) {
    if (error instanceof TypeError) throw new SyntaxError("Request body must be valid UTF-8");
    throw error;
  }
  const parsed: unknown = parseStrictJson(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("JSON object is required");
  }
  return parsed as Record<string, unknown>;
}
