import { canonicalJsonBytes, sha256Hex, type AgentResourceCollection, type AgentResourceFact, type JsonValue } from "@eval-platform/eval-contracts";
import { record } from "../json.js";

/** Bytes of present canonical JSON; sanitized whole-body placeholders remain missing. */
export function telemetryBodyLength(value: JsonValue | undefined): number | null {
  if (value === undefined || value === "[CONTENT OMITTED]" || value === "[REDACTED]") return null;
  return canonicalJsonBytes(value).byteLength;
}

/** Internal Metrics projection, never a replacement for the original SP resource snapshot. */
export async function compactResourceCollection(collection: AgentResourceCollection): Promise<AgentResourceCollection> {
  if (collection.status !== "collected") return collection;
  const telemetryEvents: AgentResourceFact[] = [];
  // Sequential hashing bounds temporary canonical JSON buffers to one event, not the full snapshot.
  for (const raw of collection.snapshot.telemetryEvents) {
    const event = record(raw.event) ?? raw;
    const payload = record(event.payload);
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
        inputLength: event.type === "tool.started" ? telemetryBodyLength(payload?.input) : null,
        outputLength: event.type === "tool.finished" ? telemetryBodyLength(payload?.output) ?? telemetryBodyLength(payload?.response) : null,
      },
    });
  }
  return { ...collection, snapshot: { ...collection.snapshot, telemetryEvents } };
}
