import { createRoute, z } from "@hono/zod-openapi";
import { ok } from "@eval-platform/eval-contracts/http";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { responseSchema } from "@springbrand/http/catalog";
import { readBytesLimited } from "@springbrand/http/server";
import { jsonContent } from "stoker/openapi/helpers";
import { createRouter } from "../../lib/create-app.js";
import { jsonBody, multipartBody } from "../../lib/request-body.js";
import type { AppRouteHandler } from "../../lib/types.js";
import { JSON_BODY_BYTES, ZIP_ARCHIVE_BYTES, ZIP_BODY_BYTES } from "../../limits.js";
import { AGENT_LIBRARY_ROUTES } from "../../sp/agent-library.js";
import { bodyErrorResponses, conflictResponse, entityIdSchema, fileSchema, jsonBodyContent, multipartBodyContent, notFoundResponse } from "../schemas.js";

const router = createRouter();
const form = z.object({ file: fileSchema, name: z.string(), clientAttachmentId: z.string() }).strict();

for (const operation of AGENT_LIBRARY_ROUTES) {
  const route = createRoute({
    method: operation.method,
    path: operation.path,
    tags: ["Agent library"],
    summary: `Relay ${operation.method.toUpperCase()} ${operation.upstream} to the fixed Eval SP account`,
    middleware: operation.body === "json" ? [jsonBody(JSON_BODY_BYTES)]
      : operation.body === "multipart" ? [multipartBody(ZIP_BODY_BYTES)] : [],
    request: {
      ...(operation.path.includes("{id}") ? { params: z.object({ id: entityIdSchema }) } : {}),
      ...(operation.body === "json" ? { body: jsonBodyContent(z.record(z.string(), z.unknown())) }
        : operation.body === "multipart" ? { body: multipartBodyContent(form) }
        : operation.body === "zip" ? { body: { required: true, content: { "application/zip": { schema: z.unknown().openapi({ type: "string", format: "binary" }) } } } } : {}),
    },
    responses: {
      200: jsonContent(responseSchema(z.unknown()), "SP public result"),
      ...bodyErrorResponses, ...notFoundResponse, ...conflictResponse,
    },
  });
  const handler: AppRouteHandler<typeof route> = async (c) => {
    let body: unknown;
    if (operation.body === "json") body = await c.req.json();
    else if (operation.body === "multipart") {
      body = await c.req.formData();
    } else if (operation.body === "zip") {
      if (!/^application\/zip(?:\s*;|$)/iu.test(c.req.header("content-type") ?? "")) {
        throw new HttpError("REQUEST_UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/zip");
      }
      const bytes = await readBytesLimited(c.req.raw, ZIP_ARCHIVE_BYTES);
      body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    const result = await c.env.sp.requestAgentLibrary(c.var.sessionToken, {
      route: operation,
      ...(operation.path.includes("{id}") ? { id: c.req.param("id")! } : {}),
      search: new URL(c.req.url).search,
      ...(body === undefined ? {} : { body }),
      signal: c.req.raw.signal,
    });
    return ok(c, result);
  };
  router.openapi(route, handler);
}

export default router;
