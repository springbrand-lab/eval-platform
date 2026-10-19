import { z } from "zod";
import type { JsonValue } from "./model.js";

type JsonObject = Readonly<Record<string, JsonValue>>;
type Step =
  | { readonly visit: unknown; readonly parent: object; readonly key: string }
  | { readonly leave: object };

const ARRAY_INDEX = /^(0|[1-9]\d*)$/u;
const JSON_VALUE_MESSAGE = "Expected finite, acyclic plain JSON data with safe integers; encode large integers as strings";

/**
 * Returns plain JSON data, or `undefined` when the value would not survive storage unchanged: a
 * detached copy, or with `detach: false` the value itself. Plain JSON data has finite numbers with safe
 * integers, and acyclic plain objects or dense arrays made only of own enumerable string-keyed data
 * properties. Iterative so nesting depth is unbounded.
 */
function readJsonValue(value: unknown, detach: boolean): JsonValue | undefined {
  const root = {};
  const ancestors = new Set<object>();
  const pending: Step[] = [{ visit: value, parent: root, key: "value" }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if ("leave" in next) {
      ancestors.delete(next.leave);
      continue;
    }
    const current = next.visit;
    if (typeof current === "number" && !isJsonNumber(current)) return undefined;
    if (current === null || typeof current === "string" || typeof current === "boolean" || typeof current === "number") {
      if (detach) define(next.parent, next.key, current);
      continue;
    }
    if (typeof current !== "object" || ancestors.has(current)) return undefined;
    const entries = ownJsonEntries(current);
    if (entries === undefined) return undefined;
    const copy = !detach ? root : Array.isArray(current) ? new Array<unknown>(current.length) : {};
    if (detach) define(next.parent, next.key, copy);
    ancestors.add(current);
    pending.push({ leave: current });
    for (const [key, child] of entries.reverse()) pending.push({ visit: child, parent: copy, key });
  }
  return detach ? (root as { value: JsonValue }).value : value as JsonValue;
}

function isJsonNumber(value: number): boolean {
  return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
}

function ownJsonEntries(value: object): Array<[string, unknown]> | undefined {
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (isArray && keys.length !== value.length + 1) return undefined;
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    if (isArray && key === "length") continue;
    if (typeof key !== "string") return undefined;
    if (isArray && (!ARRAY_INDEX.test(key) || Number(key) >= value.length)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Plain JSON data, returned as a detached copy. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.unknown().transform((input, context) => {
  const copy = readJsonValue(input, true);
  if (copy !== undefined) return copy;
  context.addIssue({ code: "custom", message: JSON_VALUE_MESSAGE });
  return z.NEVER;
});

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A plain JSON object, returned as a detached copy. */
export const jsonObjectSchema: z.ZodType<JsonObject> = jsonValueSchema.pipe(z.custom<JsonObject>(isJsonObject, "Expected a JSON object"));

/** A plain JSON object, validated by the same rules but returned as the original value; for large raw records. */
export const jsonObjectInPlaceSchema: z.ZodType<JsonObject> = z.custom<JsonObject>(
  (value) => isJsonObject(value) && readJsonValue(value, false) !== undefined,
  `Expected a JSON object. ${JSON_VALUE_MESSAGE}`,
);

/** An array of plain JSON objects, validated in place and returned as the original array; for raw resource facts. */
export const jsonObjectArrayInPlaceSchema: z.ZodType<readonly JsonObject[]> = z.custom<readonly JsonObject[]>(
  (value) => Array.isArray(value) && value.every(isJsonObject) && readJsonValue(value, false) !== undefined,
  `Expected an array of JSON objects. ${JSON_VALUE_MESSAGE}`,
);
