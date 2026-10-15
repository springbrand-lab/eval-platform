import type { JsonValue } from "@eval-platform/eval-contracts";

export type JsonRecord = Readonly<Record<string, JsonValue>>;

export function record(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

export function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** RFC 6901 reference token: `~` → `~0`, `/` → `~1`. */
export function pointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function jsonPointer(tokens: readonly string[]): string {
  return tokens.map((token) => `/${pointerToken(token)}`).join("");
}

/** First number JSON cannot carry exactly: non-finite or an integer outside the safe range. */
export function unsafeNumber(value: JsonValue, path: readonly string[]): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? undefined : jsonPointer(path);
  }
  const entries: [string, JsonValue][] = Array.isArray(value)
    ? value.map((item: JsonValue, index: number) => [String(index), item])
    : Object.entries(record(value) ?? {});
  for (const [key, item] of entries) {
    const found = unsafeNumber(item, [...path, key]);
    if (found !== undefined) return found;
  }
  return undefined;
}
