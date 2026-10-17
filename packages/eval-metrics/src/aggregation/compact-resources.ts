import { canonicalJsonBytes, sha256Hex, type AgentResourceCollection, type AgentResourceFact, type JsonValue } from "@eval-platform/eval-contracts";
import { record, text } from "../json.js";

export const TELEMETRY_PROJECTION_VERSION = 3;

const HIDDEN_TELEMETRY_TEXT = new Set([
  "[CONTENT OMITTED]",
  "[REDACTED]",
  "[Action business data withheld from telemetry]",
]);

export function hasCurrentTelemetryProjection(collection: AgentResourceCollection): boolean {
  if (collection.status !== "collected") return true;
  return collection.snapshot.telemetryEvents.every((raw) => {
    const projection = record(raw.metricProjection);
    return projection?.version === TELEMETRY_PROJECTION_VERSION
      && typeof projection.fingerprint === "string"
      && typeof projection.hasThinking === "boolean"
      && typeof projection.hasContent === "boolean"
      && typeof projection.thinkingKnown === "boolean"
      && typeof projection.contentKnown === "boolean"
      && nullableLength(projection.inputLength)
      && nullableLength(projection.outputLength);
  });
}

/** Bytes of present canonical JSON; sanitized whole-body placeholders remain missing. */
export function telemetryBodyLength(value: JsonValue | undefined): number | null {
  if (value === undefined || containsHiddenTelemetry(value)) return null;
  return canonicalJsonBytes(value).byteLength;
}

/** Uses `response` only when the public event omitted `output`; redaction stays missing. */
export function telemetryOutputLength(payload: JsonValue | undefined): number | null {
  const object = record(payload);
  if (!object) return null;
  return Object.hasOwn(object, "output") ? telemetryBodyLength(object.output) : telemetryBodyLength(object.response);
}

export interface TelemetryContentFlags {
  readonly thinking: boolean;
  readonly content: boolean;
  /** Marker absence is proven independently for each category. */
  readonly thinkingKnown: boolean;
  readonly contentKnown: boolean;
}

function hasKey(value: JsonValue | undefined, predicate: (key: string) => boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, predicate));
  const object = record(value);
  if (!object) return false;
  return Object.entries(object).some(([key, item]) => predicate(key) || hasKey(item, predicate));
}

function containsHiddenTelemetry(value: JsonValue | undefined): boolean {
  if (typeof value === "string" && HIDDEN_TELEMETRY_TEXT.has(value)) return true;
  if (Array.isArray(value)) return value.some(containsHiddenTelemetry);
  const object = record(value);
  return object !== undefined && (object.redacted === true || Object.values(object).some(containsHiddenTelemetry));
}

function nullableLength(value: JsonValue | undefined): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

/** Reads the assistant output markers used to classify a Turn without retaining its body. */
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
  const thinking = directThinking || hasKey(outputMarkers, (key) => key === "thinking" || key === "signature" || key.toLowerCase().endsWith("signature"));
  const content = directContent || hasKey(outputMarkers, (key) => key === "content");
  return {
    thinking,
    content,
    thinkingKnown: thinking || directThinking || bodyKnown,
    contentKnown: content || directContent || bodyKnown,
  };
}

/** Internal Metrics projection, never a replacement for the original SP resource snapshot. */
export async function compactResourceCollection(collection: AgentResourceCollection): Promise<AgentResourceCollection> {
  if (collection.status !== "collected" || hasCurrentTelemetryProjection(collection)) return collection;
  const telemetryEvents: AgentResourceFact[] = [];
  // Sequential hashing bounds temporary canonical JSON buffers to one event, not the full snapshot.
  for (const raw of collection.snapshot.telemetryEvents) {
    const event = record(raw.event) ?? raw;
    const payload = record(event.payload);
    const contentFlags = telemetryContentFlags(event);
    const pick = (value: AgentResourceFact | undefined, fields: readonly string[]): AgentResourceFact =>
      Object.fromEntries(fields.flatMap((key) => value?.[key] === undefined ? [] : [[key, value[key]!]]));
    telemetryEvents.push({
      event: {
        ...pick(event, ["eventId", "type", "operationId", "parentOperationId", "occurredAt"]),
        resource: pick(record(event.resource), ["sessionId"]),
        payload: pick(payload, ["outcome", "durationMs", "toolName", "inputTokens", "outputTokens", "totalTokens"]),
      },
      metricProjection: {
        version: TELEMETRY_PROJECTION_VERSION,
        fingerprint: await sha256Hex(canonicalJsonBytes(event)),
        hasThinking: contentFlags.thinking,
        hasContent: contentFlags.content,
        thinkingKnown: contentFlags.thinkingKnown,
        contentKnown: contentFlags.contentKnown,
        inputLength: event.type === "tool.started" ? telemetryBodyLength(payload?.input) : null,
        outputLength: event.type === "tool.finished" ? telemetryOutputLength(payload) : null,
      },
    });
  }
  return { ...collection, snapshot: { ...collection.snapshot, telemetryEvents } };
}
