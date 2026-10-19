import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { parseStrictJson } from "@eval-platform/eval-dataset";
import { limitRequestBody, readBytesLimited } from "@springbrand/http/server";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "./types.js";

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;|$)/iu;
const MULTIPART_MEDIA_TYPE = /^multipart\/form-data(?:\s*;|$)/iu;

function requireMediaType(request: Request, pattern: RegExp, mediaType: string): void {
  if (!pattern.test(request.headers.get("content-type") ?? "")) {
    throw new HttpError("REQUEST_UNSUPPORTED_MEDIA_TYPE", `Content-Type must be ${mediaType}`);
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new HttpError("REQUEST_INVALID_INPUT", "Request body must be valid UTF-8", { cause });
  }
}

/** Read a request body as UTF-8 text, counting the bytes actually received. */
export async function readTextBody(request: Request, maxBytes: number): Promise<string> {
  return decodeUtf8(await readBytesLimited(request, maxBytes));
}

/** Hands a bounded, UTF-8, duplicate-field-free JSON object on unchanged to the route's schema validator. */
function forwardJsonObject(request: Request, bytes: Uint8Array): Request {
  const text = decodeUtf8(bytes);
  let value: unknown;
  try {
    value = parseStrictJson(text);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    throw new HttpError("REQUEST_INVALID_JSON", undefined, { cause });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError("REQUEST_INVALID_JSON");
  return new Request(request, { body: text });
}

/** The only JSON body reader. */
export function jsonBody(maxBytes: number): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    requireMediaType(c.req.raw, JSON_MEDIA_TYPE, "application/json");
    c.req.raw = forwardJsonObject(c.req.raw, await readBytesLimited(c.req.raw, maxBytes));
    await next();
  };
}

/**
 * {@link jsonBody} for an optional body. Zero bytes are no body whatever the Content-Type claims,
 * so the route validator reads `{}`.
 */
export function optionalJsonBody(maxBytes: number): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const bytes = await readBytesLimited(c.req.raw, maxBytes);
    if (bytes.byteLength === 0) {
      const headers = new Headers(c.req.raw.headers);
      headers.delete("content-type");
      c.req.raw = new Request(c.req.raw, { body: new Uint8Array(), headers });
    } else {
      requireMediaType(c.req.raw, JSON_MEDIA_TYPE, "application/json");
      c.req.raw = forwardJsonObject(c.req.raw, bytes);
    }
    await next();
  };
}

/** The only multipart body reader: bounded bytes handed on unchanged to the route's form validator. */
export function multipartBody(maxBytes: number): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    requireMediaType(c.req.raw, MULTIPART_MEDIA_TYPE, "multipart/form-data");
    c.req.raw = await limitRequestBody(c.req.raw, maxBytes);
    await next();
  };
}
