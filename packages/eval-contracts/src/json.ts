import { z } from "zod";
import type { JsonValue } from "./model.js";

type JsonObject = Readonly<Record<string, JsonValue>>;
type Step =
  | { readonly visit: unknown; readonly parent: object; readonly key: string }
  | { readonly leave: object };

const ARRAY_INDEX = /^(0|[1-9]\d*)$/u;
const JSON_VALUE_MESSAGE = "Expected finite, acyclic plain JSON data with safe integers; encode large integers as strings";

/**
 * Returns a detached copy of plain JSON data, or `undefined` when the value would not survive storage
 * unchanged. Plain JSON data has finite numbers with safe integers, and acyclic plain objects or dense
 * arrays made only of own enumerable string-keyed data properties. Iterative so nesting depth is unbounded.
 */
function copyJsonValue(value: unknown): JsonValue | undefined {
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
      define(next.parent, next.key, current);
      continue;
    }
    if (typeof current !== "object" || ancestors.has(current)) return undefined;
    const entries = ownJsonEntries(current);
    if (entries === undefined) return undefined;
    const copy = Array.isArray(current) ? new Array<unknown>(current.length) : {};
    define(next.parent, next.key, copy);
    ancestors.add(current);
    pending.push({ leave: current });
    for (const [key, child] of entries.reverse()) pending.push({ visit: child, parent: copy, key });
  }
  return (root as { value: JsonValue }).value;
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
  const copy = copyJsonValue(input);
  if (copy !== undefined) return copy;
  context.addIssue({ code: "custom", message: JSON_VALUE_MESSAGE });
  return z.NEVER;
});

/** A plain JSON object, returned as a detached copy. */
export const jsonObjectSchema: z.ZodType<JsonObject> = jsonValueSchema.pipe(z.custom<JsonObject>(
  (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  "Expected a JSON object",
));
