import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppBindings } from "../lib/types.js";
import { fitsTaktResult, pageOf, redactLiteral, short } from "./common.js";
import type { listOptionsSchema } from "./schemas.js";

type Options = z.output<typeof listOptionsSchema>;
const invalid = () => new HttpError("RESPONSE_INVALID", "The resource catalog returned invalid metadata");

function uuid(value: unknown): string {
  const id = platformIdSchema.safeParse(value);
  if (!id.success) throw invalid();
  return id.data;
}

function size(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}

function label(value: unknown, limit: number) {
  if (typeof value !== "string") throw invalid();
  const safe = redactLiteral(value);
  return { value: short(safe.value, limit), redacted: safe.redacted, truncated: safe.value.length > limit };
}

function named(value: { name: string; description: string }) {
  const name = label(value.name, 80);
  const description = label(value.description, 120);
  return { name: name.value, description: description.value,
    ...(name.redacted || description.redacted ? { sourceRedacted: true } : {}),
    ...(name.truncated ? { nameTruncated: true } : {}),
    ...(description.truncated ? { descriptionTruncated: true } : {}) };
}

/** Only active owner-scoped catalog metadata, never file bytes or a user-controlled URL. */
export async function resourceOptions(c: Context<AppBindings>, input: Options) {
  const { category, page } = input;
  const pageSize = Math.min(input.pageSize, 5);
  const bundleId = input.bundleId;
  const resourceId = category === "material_files" ? input.materialId : input.sessionId;
  const catalog = category === "material_bundles" || category === "materials" || category === "material_files"
    ? c.var.services.materialBundles : c.var.services.sessionBundles;
  let choices: readonly Record<string, unknown>[];
  switch (category) {
    case "material_bundles":
    case "session_bundles":
      choices = (await catalog.list()).map((item) => ({ bundleId: uuid(item.bundleId), ...named(item) }));
      break;
    case "materials":
      choices = (await c.var.services.materialBundles.listResources(bundleId!)).map((item) => {
        if (uuid(item.bundleId) !== bundleId) throw invalid();
        return { bundleId, materialId: uuid(item.materialId), ...named(item), byteSize: size(item.byteSize) };
      });
      break;
    case "sessions":
      choices = (await c.var.services.sessionBundles.listResources(bundleId!)).map((item) => {
        if (uuid(item.bundleId) !== bundleId || item.format !== "json" && item.format !== "jsonl") throw invalid();
        return { bundleId, sessionId: uuid(item.sessionId), ...named(item), format: item.format };
      });
      break;
    case "material_files":
    case "session_files": {
      const files = category === "material_files"
        ? await c.var.services.materialBundles.listFiles(bundleId!, resourceId!)
        : await c.var.services.sessionBundles.listFiles(bundleId!, resourceId!);
      choices = files.map(({ path, mediaType, byteSize }) => {
        if (typeof path !== "string" || !path.startsWith("/")) throw invalid();
        const safePath = label(path, 160);
        const safeMedia = label(mediaType, 80);
        return { path: safePath.value, mediaType: safeMedia.value, byteSize: size(byteSize),
          ...(safePath.redacted || safeMedia.redacted ? { sourceRedacted: true } : {}),
          ...(safePath.truncated ? { pathTruncated: true } : {}),
          ...(safeMedia.truncated ? { mediaTypeTruncated: true } : {}) };
      });
      break;
    }
    default:
      throw new HttpError("REQUEST_INVALID_INPUT", "Unknown resource catalog category");
  }
  const result = {
    category, ...(bundleId ? { bundleId } : {}),
    ...(resourceId ? category === "material_files" ? { materialId: resourceId } : { sessionId: resourceId } : {}),
    ...pageOf(choices, page, pageSize),
  };
  if (!fitsTaktResult(result)) throw new HttpError("CATALOG_PAYLOAD_TOO_LARGE", "Resource page is too large");
  return result;
}
