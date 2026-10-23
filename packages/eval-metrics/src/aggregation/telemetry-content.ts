import { canonicalJsonBytes, type JsonValue } from "@eval-platform/eval-contracts";
import { record, text } from "../json.js";

const HIDDEN_TELEMETRY_TEXT = new Set(["[CONTENT OMITTED]", "[REDACTED]", "[Action business data withheld from telemetry]"]);

export function telemetryBodyLength(value: JsonValue | undefined): number | null {
  return value === undefined || containsHiddenTelemetry(value) ? null : canonicalJsonBytes(value).byteLength;
}

export function telemetryOutputLength(payload: JsonValue | undefined): number | null {
  const object = record(payload);
  if (!object) return null;
  return Object.hasOwn(object, "output") ? telemetryBodyLength(object.output) : telemetryBodyLength(object.response);
}

export interface TelemetryContentFlags {
  readonly thinking: boolean;
  readonly content: boolean;
  readonly thinkingKnown: boolean;
  readonly contentKnown: boolean;
}

function hasKey(value: JsonValue | undefined, predicate: (key: string) => boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, predicate));
  const object = record(value);
  return object !== undefined && Object.entries(object).some(([key, item]) => predicate(key) || hasKey(item, predicate));
}

export function containsHiddenTelemetry(value: JsonValue | undefined): boolean {
  if (typeof value === "string" && HIDDEN_TELEMETRY_TEXT.has(value)) return true;
  if (Array.isArray(value)) return value.some(containsHiddenTelemetry);
  const object = record(value);
  return object !== undefined && (object.redacted === true || Object.values(object).some(containsHiddenTelemetry));
}

export function contentMarkers(value: JsonValue | undefined): { readonly thinking: boolean; readonly content: boolean } {
  return {
    thinking: hasKey(value, (key) => key === "thinking" || key === "signature" || key.toLowerCase().endsWith("signature")),
    content: hasKey(value, (key) => key === "content"),
  };
}

export function telemetryContentFlags(event: Readonly<Record<string, JsonValue>>): TelemetryContentFlags {
  const type = text(event.type);
  if (type !== "turn.finished" && type !== "generation.finished") return { thinking: false, content: false, thinkingKnown: true, contentKnown: true };
  const payload = record(event.payload);
  if (!payload) return { thinking: false, content: false, thinkingKnown: false, contentKnown: false };
  const output = Object.hasOwn(payload, "output") ? payload.output : payload.response;
  const directThinking = Object.keys(payload).some((key) => key === "thinking" || key === "signature" || key.toLowerCase().endsWith("signature"));
  const directContent = Object.hasOwn(payload, "content");
  const outputMarkers = output ?? (directThinking || directContent ? payload : undefined);
  const bodyKnown = output !== undefined && !containsHiddenTelemetry(output);
  const markers = contentMarkers(outputMarkers);
  const thinking = directThinking || markers.thinking;
  const content = directContent || markers.content;
  return { thinking, content, thinkingKnown: thinking || bodyKnown, contentKnown: content || bodyKnown };
}
