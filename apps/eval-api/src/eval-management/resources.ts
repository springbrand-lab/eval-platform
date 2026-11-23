import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../lib/types.js";
import { collection, pageOf, readLibrary, record, short } from "./common.js";
import { resourceIdSchema, type searchResourcesSchema } from "./schemas.js";
import { readAction, readActionPage, readSuppliers } from "./agent-catalog.js";

type Search = z.output<typeof searchResourcesSchema>;
const invalid = () => new HttpError("RESPONSE_INVALID", "SP returned invalid resource metadata");

function identity(value: unknown): string {
  const parsed = resourceIdSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

function named(item: Record<string, unknown>) {
  return { id: identity(item.id), name: short(item.name), description: short(item.description, 240) };
}

function selectable(item: Record<string, unknown>) {
  return { ...named(item), status: short(item.status, 32), selectable: item.selectable === true };
}

/** An opaque within-page offset, since SP's Toolkit cursor only advances by whole pages. */
const toolkitCursorSchema = z.strictObject({
  upstream: z.string().min(1).max(256).nullable(),
  offset: z.number().int().min(0).max(200),
});
type ToolkitCursor = z.output<typeof toolkitCursorSchema>;

function decodeCursor(cursor: string | undefined): ToolkitCursor {
  if (!cursor) return { upstream: null, offset: 0 };
  try {
    return toolkitCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new HttpError("REQUEST_INVALID_INPUT", "Invalid Toolkit cursor");
  }
}

function encodeCursor(cursor: ToolkitCursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  if (encoded.length > 512) throw invalid();
  return encoded;
}

async function toolkits(c: Context<AppBindings>, { cursor, pageSize, q }: Search) {
  const position = decodeCursor(cursor);
  const query = new URLSearchParams();
  if (position.upstream) query.set("cursor", position.upstream);
  const response = record(await readLibrary(c, "/connectors", query));
  const entries = response?.items;
  const upstreamNext = response?.nextCursor;
  if (!Array.isArray(entries) || entries.length > 200 || entries.some((item) => !record(item))
    || upstreamNext !== null && (typeof upstreamNext !== "string" || upstreamNext.length < 1 || upstreamNext.length > 256)
    || position.offset > entries.length) throw invalid();

  const items: { id: string; name: string; description: string; status: string }[] = [];
  let offset = position.offset;
  const needle = q?.toLocaleLowerCase();
  while (offset < entries.length && items.length < pageSize) {
    const item = entries[offset++] as Record<string, unknown>;
    const projected = {
      id: identity(item.toolkitId), name: short(item.name), description: short(item.description, 240),
      status: short(item.status, 40),
    };
    // Never forward account connection IDs, names, icons, redirects or authentication state.
    if (!needle || projected.name.toLocaleLowerCase().includes(needle) || projected.id.toLocaleLowerCase().includes(needle)) {
      items.push(projected);
    }
  }
  const nextCursor = offset < entries.length
    ? encodeCursor({ ...position, offset })
    : typeof upstreamNext === "string" ? encodeCursor({ upstream: upstreamNext, offset: 0 }) : null;
  return { kind: "toolkits", items, nextCursor };
}

export async function searchAgentResources(c: Context<AppBindings>, input: Search) {
  const { kind, q, page, pageSize, id } = input;
  if (kind === "toolkits") return toolkits(c, input);
  if (kind === "suppliers") {
    const suppliers = (await readSuppliers(c)).data;
    const needle = q?.toLocaleLowerCase();
    return { kind, ...pageOf(suppliers.filter((supplier) => !needle || [supplier.name, supplier.description,
      ...supplier.resources.flatMap((resource) => [resource.title, resource.summary]),
    ].some((text) => text.toLocaleLowerCase().includes(needle))).map(named), page, pageSize) };
  }
  if (kind === "actions" && id) {
    const item = await readAction(c, id);
    return { kind, item: { ...selectable(item), supplierId: item.supplier ? identity(item.supplier.id) : null } };
  }
  if (kind === "actions") {
    const start = (page - 1) * pageSize;
    const header = await readActionPage(c, { page: 1, ...(q ? { q } : {}) });
    if (start >= header.total) return { kind, page, pageSize, total: header.total, items: [] };
    const firstPage = Math.floor(start / header.pageSize) + 1;
    if (firstPage > 1000) throw new HttpError("REQUEST_INVALID_INPUT", "Action catalog page is outside the SP limit");
    const first = firstPage === 1 ? header : await readActionPage(c, { page: firstPage, ...(q ? { q } : {}) });
    if (first.total !== header.total) throw invalid();
    const rows = [...first.items];
    const offset = start % first.pageSize;
    for (let next = firstPage + 1; rows.length < offset + pageSize && (next - 1) * first.pageSize < first.total; next++) {
      const following = await readActionPage(c, { page: next, ...(q ? { q } : {}) });
      if (following.total !== first.total) throw invalid();
      rows.push(...following.items);
      if (!following.items.length) break;
    }
    return { kind, page, pageSize, total: first.total,
      items: rows.slice(offset, offset + pageSize).map((item) => named(item)) };
  }
  if (kind === "models") {
    const result = await readLibrary(c, "/models");
    if (!Array.isArray(result) || result.length > 1000 || result.some((item) => !record(item))) throw invalid();
    const needle = q?.toLocaleLowerCase();
    const models = (result as Record<string, unknown>[]).map((item) => ({
      id: identity(item.id), name: short(item.name), available: item.available === true,
      requiredPlan: short(item.requiredPlan, 32), providerModel: short(item.providerModel, 100),
      thinkingLevels: Array.isArray(item.thinkingLevels) ? item.thinkingLevels.slice(0, 7).map((level) => short(level, 16)) : [],
    })).filter((item) => !needle || item.name.toLocaleLowerCase().includes(needle)
      || item.id.toLocaleLowerCase().includes(needle));
    return { kind, ...pageOf(models, page, pageSize) };
  }
  if (id) {
    const item = record(await readLibrary(c, "/user-references/{id}", new URLSearchParams(), id));
    if (!item || identity(item.id) !== id) throw invalid();
    return { kind, item: { ...named(item), status: short(item.status, 32), size: nonnegative(item.size),
      mediaType: short(item.mediaType, 80) } };
  }

  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (q) query.set("q", q);
  if (kind === "skills") query.set("view", "selectable");
  if (kind === "connector_components" || kind === "extensions") {
    query.set("kind", kind === "extensions" ? "extension" : "connector");
  }
  const path = {
    skills: "/skills",
    connector_components: "/components", extensions: "/components", references: "/user-references",
  } as const;
  const { data, total } = collection(await readLibrary(c, path[kind], query), pageSize);
  const items = data.map((item) => {
    if (kind === "skills") return { ...named(item), available: item.available === true, deleted: item.deleted === true };
    if (kind === "references") return { ...named(item), status: short(item.status, 32),
      size: nonnegative(item.size), mediaType: short(item.mediaType, 80) };
    return selectable(item);
  });
  return { kind, page, pageSize, total, items };
}

function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid();
  return value as number;
}
