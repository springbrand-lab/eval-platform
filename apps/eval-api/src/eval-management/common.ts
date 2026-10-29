import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Context } from "hono";
import type { ProjectRunView } from "../db/run-view.js";
import type { AppBindings, OwnerServices } from "../lib/types.js";
import { AGENT_LIBRARY_ROUTES } from "../sp/agent-library.js";

/** MCP results go into a model context, never a bulk download. */
export const TOOL_RESULT_BYTES = 32_000;
export const MAX_PREVIEW_TARGETS = 50;

export function text(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined || Buffer.byteLength(result, "utf8") > TOOL_RESULT_BYTES) {
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
