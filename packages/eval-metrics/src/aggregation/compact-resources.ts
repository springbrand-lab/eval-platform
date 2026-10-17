import { canonicalJsonBytes, sha256Hex, type AgentResourceCollection, type AgentResourceFact, type JsonValue } from "@eval-platform/eval-contracts";
import { record, text } from "../json.js";

/** Bytes of present canonical JSON; sanitized whole-body placeholders remain missing. */
export function telemetryBodyLength(value: JsonValue | undefined): number | null {
  if (value === undefined || value === "[CONTENT OMITTED]" || value === "[REDACTED]") return null;
  return canonicalJsonBytes(value).byteLength;
}

export interface TelemetryContentFlags {
  readonly thinking: boolean;
  readonly content: boolean;
}

function hasKey(value: JsonValue | undefined, predicate: (key: string) => boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, predicate));
  const object = record(value);
  if (!object) return false;
  return Object.entries(object).some(([key, item]) => predicate(key) || hasKey(item, predicate));
}

/** Reads the assistant output markers used to classify a Turn without retaining its body. */
export function telemetryContentFlags(event: Readonly<Record<string, JsonValue>>): TelemetryContentFlags {
  const type = text(event.type);
  if (type !== "turn.finished" && type !== "generation.finished") return { thinking: false, content: false };
  const payload = record(event.payload);
  if (!payload) return { thinking: false, content: false };
  const output = payload.output ?? payload.response;
  const directThinking = Object.keys(payload).some((key) => key === "thinking" || key === "signature" || key.toLowerCase().endsWith("signature"));
  const directContent = Object.hasOwn(payload, "content");
  const outputMarkers = output ?? (Object.hasOwn(payload, "input") ? undefined : payload);
  return {
    thinking: directThinking || hasKey(outputMarkers, (key) => key === "thinking" || key === "signature" || key.toLowerCase().endsWith("signature")),
    content: directContent || hasKey(outputMarkers, (key) => key === "content"),
  };
}

/** Internal Metrics projection, never a replacement for the original SP resource snapshot. */
export async function compactResourceCollection(collection: AgentResourceCollection): Promise<AgentResourceCollection> {
  if (collection.status !== "collected") return collection;
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
        version: 1,
        fingerprint: await sha256Hex(canonicalJsonBytes(event)),
        hasThinking: contentFlags.thinking,
        hasContent: contentFlags.content,
        inputLength: event.type === "tool.started" ? telemetryBodyLength(payload?.input) : null,
        outputLength: event.type === "tool.finished" ? telemetryBodyLength(payload?.output) ?? telemetryBodyLength(payload?.response) : null,
      },
    });
  }
  return { ...collection, snapshot: { ...collection.snapshot, telemetryEvents } };
}
