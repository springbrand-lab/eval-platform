import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { ProjectRunView } from "../db/run-view.js";
import type { AppBindings, OwnerServices } from "../lib/types.js";
import { AGENT_LIBRARY_ROUTES } from "../sp/agent-library.js";

/** MCP results go into a model context, never a bulk download. */
export const TOOL_RESULT_BYTES = 32_000;
/** Metrics text and a complete displayed JSON document each have a 10 MiB budget. */
export const METRICS_TOOL_RESULT_BYTES = 10 * 1024 * 1024;
/** JSON continuation and Schema catalog pages remain small. */
export const TAKT_RESULT_CHARS = 4_800;
export const MAX_PREVIEW_TARGETS = 50;
const JSON_CHUNK_BYTES = 2_048;
/** MCP continuations rescan only this bounded document; larger documents use one authenticated GET. */
const MAX_PAGED_JSON_BYTES = 16_384;
const REDACTED = "[REDACTED: sensitive source content]";
const SENSITIVE_SOURCE_KEY = /^(?:userPrompt|evalPrompt|systemPrompt|privatePrompt|prompt|instructions|password|secret|token|authorization|credential|url|uri|endpoint|(?:api|access|secret|private|client)[-_]?(?:key|token|secret))$/iu;
const SENSITIVE_SOURCE_LITERAL = /(?:(?:mailto|data):|www\.|Bearer\s+\S+|-----BEGIN\s+[^-]*PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\b(?:sk|ghp|glpat|xox[baprs])[-_][\w-]{8,}|\b(?:(?:api|access|secret|private|client)[-_ ]?(?:key|token|secret)|password|private[-_ ]?prompt|credential|authorization)\s*[:=]\s*\S+)/iu;
const URL_SCHEME_CHAR = /[a-z0-9+.-]/iu;
const URL_SCHEME_START = /[a-z]/iu;

function hasSourceUrl(value: string): boolean {
  for (let delimiter = value.indexOf("://"); delimiter !== -1;
    delimiter = value.indexOf("://", delimiter + 3)) {
    for (let at = delimiter - 1; at >= 0 && URL_SCHEME_CHAR.test(value[at]!); at--) {
      if (URL_SCHEME_START.test(value[at]!)) return true;
    }
  }
  return false;
}

/** A field name like "url" is safe to display, but its value is not (even if it is numeric or nested). */
export function sensitiveJsonKey(name: string): boolean {
  return SENSITIVE_SOURCE_KEY.test(name);
}

/** Metrics paths have JSON Pointer escaping; check each source field name, not the entire path. */
export function sensitiveJsonPointer(pointer: string): boolean {
  return pointer.startsWith("/") && pointer.slice(1).split("/")
    .some((part) => sensitiveJsonKey(part.replace(/~1/gu, "/").replace(/~0/gu, "~")));
}

export interface JsonChunk {
  readonly text: string;
  readonly offset: number;
  readonly totalBytes: number;
  readonly nextOffset: number | null;
  /** SHA-256 of the complete displayed JSON, not just this page or the original source file. */
  readonly sha256: string;
}

export interface DisplayJson {
  readonly bytes: Buffer | null;
  /** Null means a source key itself was unsafe, so no part of the document can be displayed. */
  readonly display: { readonly totalBytes: number; readonly sha256: string } | null;
  readonly sourceRedacted: boolean;
}

export interface JsonChunkResult {
  readonly chunk: JsonChunk | null;
  readonly sourceRedacted: boolean;
  /** No repeated 2KiB reads of a large document; use the fixed, authenticated documents GET instead. */
  readonly streamRequired?: true;
  /** SHA-256 and size of the *displayed* JSON, for binding the trusted GET to this selection. */
  readonly display?: NonNullable<DisplayJson["display"]>;
}

/** Both character count and actual UTF-8 bytes matter for a multilingual model response. */
export function fitsTaktResult(value: unknown): boolean {
  const result = JSON.stringify(value);
  return result !== undefined && result.length <= TAKT_RESULT_CHARS
    && Buffer.byteLength(result, "utf8") <= TAKT_RESULT_CHARS;
}

/** Source-authored strings must not turn a read-only metrics/schema tool into a URL/credential/prompt reader. */
export function redactLiteral(value: string, key = "", privatePrompts: readonly string[] = []) {
  const redacted = hasSourceUrl(value) || SENSITIVE_SOURCE_LITERAL.test(value) || sensitiveJsonKey(key)
    || privatePrompts.some((prompt) => prompt.length > 0 && value.includes(prompt));
  return { value: redacted ? REDACTED : value, redacted };
}

/**
 * Validate and prepare the *whole* canonical displayed JSON once per read.
 * Never expose a partial document when a key itself contains a URL/secret/prompt.
 * Values of safe sensitive keys (including "url"/"token"/"prompt") are masked at
 * any type, while ordinary field identities and safe values remain available.
 */
export function displayJson(value: unknown, privatePrompts: readonly string[] = []): DisplayJson {
  const visited = new WeakSet<object>();
  let sourceRedacted = false;
  let unsafeFieldName = false;
  const invalid = () => new HttpError("RESPONSE_INVALID", "The source is not a lossless JSON document");
  const display = (item: unknown, key: string, depth: number): unknown => {
    if (depth > 512) throw invalid();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      const safe = redactLiteral(item, key, privatePrompts);
      sourceRedacted ||= safe.redacted;
      return safe.value;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item)) throw invalid();
      return item;
    }
    if (typeof item !== "object" || visited.has(item)) throw invalid();
    visited.add(item);
    if (Array.isArray(item)) {
      const keys = Object.keys(item);
      if (keys.length !== item.length || keys.some((entry, index) => entry !== String(index))) throw invalid();
      return item.map((element, index) => display(element, String(index), depth + 1));
    }
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null
      || Reflect.ownKeys(item).length !== Object.keys(item).length) throw invalid();
    const safe: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [name, entry] of Object.entries(item)) {
      if (redactLiteral(name, "", privatePrompts).redacted) {
        unsafeFieldName = true;
        return null;
      }
      if (sensitiveJsonKey(name)) {
        safe[name] = REDACTED;
        sourceRedacted = true;
      } else {
        safe[name] = display(entry, name, depth + 1);
      }
      if (unsafeFieldName) return null;
    }
    return safe;
  };
  const document = display(value, "", 0);
  if (unsafeFieldName) {
    return { bytes: null, display: null, sourceRedacted: true };
  }
  const canonical = JSON.stringify(document);
  if (Buffer.byteLength(canonical, "utf8") > METRICS_TOOL_RESULT_BYTES) {
    throw new HttpError("CATALOG_PAYLOAD_TOO_LARGE", "The complete displayed JSON document exceeds 10 MiB");
  }
  const encoded = Buffer.from(canonical, "utf8");
  return { bytes: encoded, display: { totalBytes: encoded.length,
    sha256: createHash("sha256").update(encoded).digest("hex") }, sourceRedacted };
}

/**
 * Small canonical JSON documents are sliced on UTF-8 code-point boundaries.
 * The 16KiB threshold bounds repeated full-document work, *not* source size:
 * larger documents have a one-shot authenticated stream with the same digest.
 * The caller bounds the entire model response (escaping and metadata included).
 */
export function jsonChunk(
  value: unknown, offset: number, privatePrompts: readonly string[] = [],
  fits?: (chunk: JsonChunk, sourceRedacted: boolean) => boolean,
): JsonChunkResult {
  const { bytes: encoded, display, sourceRedacted } = displayJson(value, privatePrompts);
  if (!encoded || !display) {
    if (offset !== 0) throw new HttpError("REQUEST_INVALID_INPUT", "The source has no safe JSON continuation");
    return { chunk: null, sourceRedacted };
  }
  if (encoded.length > MAX_PAGED_JSON_BYTES) {
    if (offset !== 0) throw new HttpError("REQUEST_INVALID_INPUT", "Large JSON has no MCP continuation; use the authenticated documents GET");
    return { chunk: null, sourceRedacted, streamRequired: true, display };
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= encoded.length
    || offset > 0 && (encoded[offset]! & 0xc0) === 0x80) {
    throw new HttpError("REQUEST_INVALID_INPUT", "Invalid JSON byte offset");
  }
  for (let maxBytes = JSON_CHUNK_BYTES; ; maxBytes = Math.floor(maxBytes / 2)) {
    let end = Math.min(offset + maxBytes, encoded.length);
    while (end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end--;
    // Even a one-byte allowance must include a whole UTF-8 code point, or explicitly fail.
    if (end <= offset) {
      end = offset + 1;
      while (end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end++;
    }
    const chunk = {
      text: encoded.toString("utf8", offset, end), offset, totalBytes: encoded.length,
      nextOffset: end === encoded.length ? null : end, sha256: display.sha256,
    };
    if (!fits || fits(chunk, sourceRedacted)) return { chunk, sourceRedacted };
    if (maxBytes <= 1) {
      throw new HttpError("CATALOG_PAYLOAD_TOO_LARGE", "The JSON result metadata exceeds the model-output limit");
    }
  }
}

export function text(value: unknown, maxChars = Infinity, maxBytes = TOOL_RESULT_BYTES): string {
  const result = JSON.stringify(value);
  const byteLength = result === undefined ? 0 : Buffer.byteLength(result, "utf8");
  if (result === undefined || byteLength > maxBytes
    || result.length > maxChars || byteLength > maxChars) {
    throw new HttpError("CATALOG_PAYLOAD_TOO_LARGE", "The result is too large; select a smaller page");
  }
  return result;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function short(value: unknown, length = 160): string {
  return typeof value === "string" ? value.slice(0, length).replace(/[\u0000-\u001f\u007f]/gu, " ") : "";
}

export function pageOf<T>(items: readonly T[], page: number, pageSize: number) {
  return { page, pageSize, total: items.length, items: items.slice((page - 1) * pageSize, page * pageSize) };
}

/** Validate the public SP collection envelope before projecting its *allowlisted* fields. */
export function collection(value: unknown, maxItems = 50): { readonly data: readonly Record<string, unknown>[]; readonly total: number } {
  const body = record(value);
  if (!body || !Array.isArray(body.data) || body.data.length > maxItems
    || !Number.isSafeInteger(body.total) || (body.total as number) < 0
    || body.data.some((item: unknown) => !record(item))) {
    throw new HttpError("RESPONSE_INVALID", "SP returned an invalid catalog page");
  }
  return { data: body.data as Record<string, unknown>[], total: body.total as number };
}

/** Only these GETs of the existing SP editor library may be reached by model-visible tools. */
export async function readLibrary(
  c: Context<AppBindings>, path: (typeof AGENT_LIBRARY_ROUTES)[number]["path"],
  query = new URLSearchParams(), id?: string,
): Promise<unknown> {
  const route = AGENT_LIBRARY_ROUTES.find((candidate) => candidate.method === "get" && candidate.path === path);
  if (!route) throw new HttpError("REQUEST_INVALID_INPUT", "Unknown catalog");
  return c.env.sp.requestAgentLibrary(c.var.sessionToken, {
    route, ...(id === undefined ? {} : { id }), search: query.size ? `?${query}` : "",
    signal: c.req.raw.signal,
  });
}

export async function requireRun(services: OwnerServices, projectId: string, runId: string): Promise<ProjectRunView> {
  const view = await services.projectRuns.readRun(projectId, runId);
  if (!view) throw new HttpError("RUN_NOT_FOUND");
  return view;
}
