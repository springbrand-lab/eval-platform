import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { parseStrictJson } from "@eval-platform/eval-dataset";
import { readBytesLimited } from "@springbrand/http/server";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "./types.js";

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;|$)/iu;

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

/**
 * The only JSON body reader: a bounded, UTF-8, duplicate-field-free JSON object. The accepted
 * text is handed on unchanged to the route's schema validator.
 */
export function jsonBody(maxBytes: number): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (!JSON_MEDIA_TYPE.test(c.req.header("content-type") ?? "")) {
      throw new HttpError("REQUEST_UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
    }
    const text = await readTextBody(c.req.raw, maxBytes);
    let value: unknown;
    try {
      value = parseStrictJson(text);
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      throw new HttpError("REQUEST_INVALID_JSON", undefined, { cause });
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError("REQUEST_INVALID_JSON");
    c.req.raw = new Request(c.req.raw, { body: text });
    await next();
  };
}
