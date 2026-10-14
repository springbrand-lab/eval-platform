import type { EvalDb } from "./db/client.js";
import type { CatalogMetadataPatch } from "./db/catalog-metadata.js";
import { createResourceCatalog } from "./db/resource-catalog.js";
import { methodNotAllowed, onlyFields, readJsonObject } from "./catalog-http-body.js";
import { createInitialResourceApi } from "./initial-resources.js";
import { handleOutputSchemaHttpRequest } from "./output-schemas.http.js";
import type { BundleDirectory, MaterialFile } from "./sp/bundle-directory.js";

const BUNDLES_ROUTE = /^\/api\/bundles$/u;
const BUNDLE_ROUTE = /^\/api\/bundles\/([^/]+)$/u;
const MATERIALS_ROUTE = /^\/api\/bundles\/([^/]+)\/materials$/u;
const MATERIAL_ROUTE = /^\/api\/bundles\/([^/]+)\/materials\/([^/]+)$/u;
const SESSIONS_ROUTE = /^\/api\/bundles\/([^/]+)\/sessions$/u;
const SESSION_ROUTE = /^\/api\/bundles\/([^/]+)\/sessions\/([^/]+)$/u;
const DATA_ROUTE = /^\/api\/data\/([^/]+)\/initial-resources$/u;

/** Mount after Eval SP session authentication; ownerUserId is trusted server input. */
export function createInitialResourceHttpHandler(db: EvalDb, bundles: BundleDirectory) {
  return async (request: Request, ownerUserId: string): Promise<Response | null> => {
    const outputResponse = await handleOutputSchemaHttpRequest(db, request, ownerUserId);
    if (outputResponse) return outputResponse;
    const pathname = new URL(request.url).pathname;
    const bundle = BUNDLE_ROUTE.exec(pathname);
    const materials = MATERIALS_ROUTE.exec(pathname);
    const material = MATERIAL_ROUTE.exec(pathname);
    const sessions = SESSIONS_ROUTE.exec(pathname);
    const session = SESSION_ROUTE.exec(pathname);
    const selectedData = DATA_ROUTE.exec(pathname);
    if (!BUNDLES_ROUTE.test(pathname) && !bundle && !materials && !material &&
      !sessions && !session && !selectedData) return null;

    if (BUNDLES_ROUTE.test(pathname) || bundle || materials || material || sessions || session) {
      const catalog = createResourceCatalog(db, ownerUserId, bundles);
      if (BUNDLES_ROUTE.test(pathname)) {
        if (request.method === "GET") return Response.json(await catalog.listBundles());
        if (request.method === "POST") {
          const body = await readJsonObject(request, 4_096);
          onlyFields(body, ["name", "description"]);
          return Response.json(await catalog.createBundle(body as { name: string; description: string }), { status: 201 });
        }
        return methodNotAllowed("GET, POST");
      }
      const bundleId = decodeURIComponent((bundle ?? materials ?? material ?? sessions ?? session)![1]!);
      if (bundle) {
        if (request.method === "GET") return Response.json(await catalog.getBundle(bundleId));
        if (request.method === "PATCH") return Response.json(await catalog.updateBundle(bundleId,
          await readJsonObject(request, 4_096) as CatalogMetadataPatch));
        if (request.method === "DELETE") { await catalog.deleteBundle(bundleId); return new Response(null, { status: 204 }); }
        return methodNotAllowed("GET, PATCH, DELETE");
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
        return methodNotAllowed("GET, POST");
      }
      if (material) {
        const materialId = decodeURIComponent(material[2]!);
        if (request.method === "GET") return Response.json(await catalog.getMaterial(bundleId, materialId));
        if (request.method === "PATCH") return Response.json(await catalog.updateMaterial(bundleId, materialId,
          await readJsonObject(request, 4_096) as CatalogMetadataPatch));
        if (request.method === "DELETE") { await catalog.deleteMaterial(bundleId, materialId); return new Response(null, { status: 204 }); }
        return methodNotAllowed("GET, PATCH, DELETE");
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
        return methodNotAllowed("GET, POST");
      }
      const sessionId = decodeURIComponent(session![2]!);
      if (request.method === "GET") return Response.json(await catalog.getSession(bundleId, sessionId));
      if (request.method === "PATCH") return Response.json(await catalog.updateSession(bundleId, sessionId,
        await readJsonObject(request, 4_096) as CatalogMetadataPatch));
      if (request.method === "DELETE") { await catalog.deleteSession(bundleId, sessionId); return new Response(null, { status: 204 }); }
      return methodNotAllowed("GET, PATCH, DELETE");
    }
    if (request.method !== "PATCH") return methodNotAllowed("PATCH");
    const body = await readJsonObject(request, 4_096);
    return Response.json(await createInitialResourceApi(db, ownerUserId, bundles)
      .bindData(decodeURIComponent(selectedData![1]!), body));
  };
}
