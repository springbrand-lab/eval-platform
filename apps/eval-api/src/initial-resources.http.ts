import type { EvalDb } from "./db/client.js";
import { createInitialResourceApi } from "./initial-resources.js";
import type { BundleDirectory } from "./sp/bundle-directory.js";
import { parseStrictJson } from "./strict-json.js";

const MATERIAL_ROUTE = /^\/api\/bundles\/([^/]+)\/materials\/([^/]+)$/u;
const SESSION_ROUTE = /^\/api\/bundles\/([^/]+)\/sessions\/([^/]+)$/u;
const DATA_ROUTE = /^\/api\/data\/([^/]+)\/initial-resources$/u;

/** Mount after Eval SP session authentication; ownerUserId is trusted server input. */
export function createInitialResourceHttpHandler(db: EvalDb, bundles: BundleDirectory) {
  return async (request: Request, ownerUserId: string): Promise<Response | null> => {
    const pathname = new URL(request.url).pathname;
    const material = MATERIAL_ROUTE.exec(pathname);
    const session = SESSION_ROUTE.exec(pathname);
    const selectedData = DATA_ROUTE.exec(pathname);
    if (!material && !session && !selectedData) return null;
    const api = createInitialResourceApi(db, ownerUserId, bundles);
    if (material) {
      if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "PUT" } });
      const body = await readJsonObject(request, 27_000_000);
      if (Object.keys(body).length !== 1 || !Array.isArray(body.files)) {
        throw new TypeError("Material upload requires only a files array");
      }
      return Response.json(await api.uploadMaterials({
        bundleId: decodeURIComponent(material[1]!), materialId: decodeURIComponent(material[2]!),
      }, body.files), { status: 200 });
    }
    if (session) {
      if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "PUT" } });
      const body = await readJsonObject(request, 2_500_000);
      if (Object.keys(body).some((key) => key !== "format" && key !== "content")) {
        throw new TypeError("Session upload accepts only format and content");
      }
      return Response.json(await api.uploadSession({
        bundleId: decodeURIComponent(session[1]!), sessionId: decodeURIComponent(session[2]!),
      }, body as { format: "json" | "jsonl"; content: string }), { status: 200 });
    }
    if (request.method !== "PATCH") return new Response(null, { status: 405, headers: { Allow: "PATCH" } });
    const body = await readJsonObject(request, 4_096);
    return Response.json(await api.bindData(decodeURIComponent(selectedData![1]!), body));
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
