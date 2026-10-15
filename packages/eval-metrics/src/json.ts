import type { JsonValue } from "@eval-platform/eval-contracts";

export type JsonRecord = Readonly<Record<string, JsonValue>>;

export function record(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

export function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
