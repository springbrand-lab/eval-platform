import type { EvalDb } from "./db/client.js";
import { bindProjectEvaluationOutputSchema } from "./db/catalog.js";
import type { CatalogMetadataPatch } from "./db/catalog-metadata.js";
import { OutputSchemaNotFoundError } from "./db/errors.js";
import { createOutputSchemaCatalog } from "./db/output-schemas.js";
import { methodNotAllowed, onlyFields, readJsonObject } from "./catalog-http-body.js";

const OUTPUT_SCHEMAS_ROUTE = /^\/api\/evaluation-output-schemas$/u;
const OUTPUT_SCHEMA_ROUTE = /^\/api\/evaluation-output-schemas\/([^/]+)$/u;
const PROJECT_SCHEMA_ROUTE = /^\/api\/projects\/([^/]+)\/evaluation-output-schema$/u;

/** Output-format catalog and Project ID binding, mounted after session authentication. */
export async function handleOutputSchemaHttpRequest(
  db: EvalDb, request: Request, ownerUserId: string,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const outputSchema = OUTPUT_SCHEMA_ROUTE.exec(pathname);
  const projectSchema = PROJECT_SCHEMA_ROUTE.exec(pathname);
  if (!OUTPUT_SCHEMAS_ROUTE.test(pathname) && !outputSchema && !projectSchema) return null;
  if (projectSchema) {
    if (request.method !== "PUT") return methodNotAllowed("PUT");
    const body = await readJsonObject(request, 4_096);
    onlyFields(body, ["outputSchemaId"]);
    if (body.outputSchemaId !== null && typeof body.outputSchemaId !== "string") {
      throw new TypeError("outputSchemaId must be a UUID or null");
    }
    return Response.json(await bindProjectEvaluationOutputSchema(
      db, ownerUserId, decodeURIComponent(projectSchema[1]!), body.outputSchemaId,
    ));
  }
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
    return methodNotAllowed("GET, POST");
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
  return methodNotAllowed("GET, PATCH, DELETE");
}
