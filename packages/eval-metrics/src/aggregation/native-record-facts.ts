import {
  PI_TRAJECTORY_RECORD_FORMAT, canonicalJsonBytes, type JsonValue, type PiTrajectoryRecord,
} from "@eval-platform/eval-contracts";
import { record, text, type JsonRecord } from "../json.js";

/**
 * A deliberately narrow, body-free adapter for the *published UA* TrajectoryRecord
 * envelope. The full native record is never converted to an old event. The public
 * `readTrajectoryBookkeeping` defines the public bookkeeping contract. The
 * fixture is checked with that helper; the production adapter reads only the
 * bounded fields below until its published dependency can be installed offline.
 * An unrecognized fact is unsupported, not evidence of a complete empty stream.
 */
export type NativeMetricFact = JsonRecord;

const HIDDEN = new Set(["[REDACTED]", "[CONTENT OMITTED]", "[Action business data withheld from telemetry]"]);
const BOOKKEEPING = "springbrand.trajectory";
const OUTCOMES = new Set(["completed", "failed", "cancelled"]);
const OTHER_EVENTS = new Set([
  "approval.requested", "approval.decided", "interaction.requested", "interaction.responded",
  "interaction.cancelled", "context.compacted",
]);

function hidden(value: JsonValue | undefined): boolean {
  const pending: (JsonValue | undefined)[] = [value];
  let examined = 0;
  while (pending.length > 0) {
    // A safe but unreasonably complex Tool value cannot prove an exact length.
    if (++examined > 10_000) return true;
    const current = pending.pop();
    if (typeof current === "string") {
      if (HIDDEN.has(current)) return true;
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    const object = record(current);
    if (object?.redacted === true) return true;
    if (object) for (const item of Object.values(object)) pending.push(item);
  }
  return false;
}

/** Byte statistics only for present safe Pi Tool bodies. Never read request.options or rebuild a generation input. */
function toolBytes(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null || hidden(value)) return null;
  try {
    return canonicalJsonBytes(value).byteLength;
  } catch {
    // A deeply nested body is not a trustworthy zero-byte result.
    return null;
  }
}

function positive(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Native IDs, not telemetry event IDs: a temporary Agent and another Submission cannot collide. */
function nativeKey(source: PiTrajectoryRecord, value: string | number): string {
  return JSON.stringify([source.resource.agentId, source.resource.sessionId, source.submissionId, value]);
}

function parentTurn(source: PiTrajectoryRecord, event: JsonRecord): string | null {
  return text(event.parentOperationId) ? nativeKey(source, event.parentOperationId as string) : null;
}

function flags(content: JsonValue | undefined): { thinking: boolean | null; content: boolean | null } {
  if (!Array.isArray(content)) return { thinking: null, content: null };
  const blocks = content.map(record);
  if (blocks.some((block) => !text(block?.type))) return { thinking: null, content: null };
  const thinking = blocks.some((block) => block!.type === "thinking" ||
    Object.keys(block!).some((key) => key.toLowerCase().endsWith("signature")));
  const textBlock = blocks.some((block) => block!.type === "text");
  // UA's safe projector redacts *values*, not Pi block identities. A provider-native
  // opaque block cannot prove the absence of either category.
  const opaque = blocks.some((block) => block!.type === "providerNative");
  return { thinking: thinking || !opaque ? thinking : null, content: textBlock || !opaque ? textBlock : null };
}

function eventFacts(source: PiTrajectoryRecord, data: JsonRecord): readonly NativeMetricFact[] | undefined {
  const event = record(data.event);
  const payload = record(event?.payload);
  if (!event || !payload || event.schemaVersion !== 1 || !text(event.eventId)
    || !text(event.operationId) || !Number.isSafeInteger(event.occurredAt)
    || (typeof event.occurredAt === "number" && event.occurredAt < 0)
    || record(event.resource)?.sessionId !== source.resource.sessionId
    || record(event.resource)?.agentId !== source.resource.agentId
    || (event.submissionId !== undefined && event.submissionId !== source.submissionId)
    // Public bookkeeping omits Pi-owned conversation content from events.
    || ["input", "output", "prompt", "content", "summary"].some((key) => payload[key] !== undefined)) return undefined;
  const op = nativeKey(source, event.operationId as string);
  const occurredAt = event.occurredAt as number;
  if (["turn.finished", "generation.finished", "tool.finished"].includes(String(event.type))
    && !OUTCOMES.has(String(payload.outcome))) return undefined;
  if (event.type === "turn.admitted" || event.type === "turn.started" ||
    event.type === "turn.steered" || event.type === "turn.recovering") {
    return [{ type: "turn", phase: "start", id: op, timestamp: occurredAt, eventId: event.eventId ?? null }];
  }
  if (event.type === "turn.finished" || event.type === "turn.cancelled") {
    return [{ type: "turn", phase: "end", id: op, timestamp: occurredAt,
      status: event.type === "turn.cancelled" ? "cancelled" : payload.outcome ?? null,
      durationMs: payload.durationMs ?? null, eventId: event.eventId ?? null }];
  }
  if (event.type === "generation.started" || event.type === "generation.finished") {
    if (!text(payload.generationId)) return undefined;
    return [{ type: "model", phase: event.type === "generation.started" ? "start" : "end",
      id: op, turnId: parentTurn(source, event), timestamp: occurredAt,
      status: event.type === "generation.finished" ? payload.outcome ?? null : null,
      durationMs: payload.durationMs ?? null,
      assistantTimestamp: record(data.refs)?.assistantTimestamp ?? null,
      inputTokens: payload.inputTokens ?? null, outputTokens: payload.outputTokens ?? null,
      totalTokens: payload.totalTokens ?? null, eventId: event.eventId ?? null }];
  }
  if (event.type === "tool.started" || event.type === "tool.finished") {
    if (!text(payload.toolName)) return undefined;
    const callId = text(event.toolCallId);
    return [{ type: "tool", phase: event.type === "tool.started" ? "start" : "end",
      id: callId ? nativeKey(source, callId) : null, turnId: parentTurn(source, event),
      toolName: payload.toolName ?? null, timestamp: occurredAt,
      status: event.type === "tool.finished" ? payload.outcome ?? null : null,
      durationMs: payload.durationMs ?? null, fromEvent: true, eventId: event.eventId ?? null,
      // `input`/`output` are intentionally absent from UA event facts: Pi owns them.
    }];
  }
  // A subagent may execute more generations/Tools than this parent event shows.
  // Until actual scoped child delivery is proven, it cannot establish their absence.
  return OTHER_EVENTS.has(String(event.type)) ? [] : undefined;
}

function messageFacts(source: PiTrajectoryRecord, native: JsonRecord): readonly NativeMetricFact[] | undefined {
  if (native.head !== undefined || native.edits !== undefined) return undefined;
  if (native.model === undefined) return native.kind === "pi.user" || native.kind === "pi.system" ? [] : undefined;
  // Pi stores the source message in model[0]. A multi-message/delta entry needs
  // conversation reconstruction, which the compact interpreter intentionally does not do.
  if (!Array.isArray(native.model) || native.model.length !== 1) return undefined;
  const facts: NativeMetricFact[] = [];
  for (const value of native.model) {
    const message = record(value);
    if (!message || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)
      || message.timestamp < 0) return undefined;
    if (message.role === "assistant") {
      if (!Array.isArray(message.content) || !text(message.stopReason) || !record(message.usage)) return undefined;
      const markers = flags(message.content);
      facts.push({ type: "assistant", id: nativeKey(source, native.id as number),
        timestamp: message.timestamp, taskId: positive(native.byTaskId) ? nativeKey(source, native.byTaskId) : null,
        thinking: markers.thinking, content: markers.content,
        inputTokens: record(message.usage)?.input ?? null,
        outputTokens: record(message.usage)?.output ?? null,
        totalTokens: record(message.usage)?.totalTokens ?? null });
      for (const blockValue of message.content) {
        const block = record(blockValue);
        if (block?.type !== "toolCall") continue;
        const callId = text(block.id);
        facts.push({ type: "tool", phase: "start", id: callId ? nativeKey(source, callId) : null,
          toolName: block.name ?? null, timestamp: message.timestamp,
          inputLength: toolBytes(block.arguments), fromPiCall: true });
      }
      continue;
    }
    if (message.role === "toolResult") {
      if (!Array.isArray(message.content)) return undefined;
      const callId = text(message.toolCallId);
      facts.push({ type: "tool", phase: "result", id: callId ? nativeKey(source, callId) : null,
        toolName: message.toolName ?? null, timestamp: message.timestamp,
        status: message.isError === true ? "failed" : message.isError === false ? "completed" : null,
        durationMs: message.durationMs ?? null, outputLength: toolBytes(message.content), fromPiResult: true });
    } else if ((message.role !== "user" && message.role !== "system")
      || (native.kind !== "pi.user" && native.kind !== "pi.system")) return undefined;
  }
  return facts;
}

/** Focused extraction of *actual* safe Pi records. Bookkeeping request/hook facts
 * are auxiliary, not replacements for generation/tool terminal events or Pi messages. */
export function nativeRecordFacts(source: JsonRecord): readonly NativeMetricFact[] | undefined {
  if (source.format !== PI_TRAJECTORY_RECORD_FORMAT || record(source.projection)?.kind !== "safe") return undefined;
  if (!text(record(source.resource)?.agentId) || !text(record(source.resource)?.sessionId)
    || (!text(source.submissionId) && source.submissionId !== null)) return undefined;
  const native = source as unknown as PiTrajectoryRecord;
  if (native.submissionId === null) return native.origin === "context" ? [] : undefined;
  const write = record(native.record);
  const value = record(write?.value);
  if (!value) return undefined;
  if (write?.type === "conversation") return [];
  if (write?.type !== "entry" || !positive(value.id)) return undefined;
  const withScope = (facts: readonly NativeMetricFact[] | undefined): readonly NativeMetricFact[] | undefined =>
    facts?.map((fact) => ({ ...fact, scopeKey: JSON.stringify([
      native.resource.agentId, native.resource.sessionId, native.submissionId,
    ]) }));
  if (value.kind === BOOKKEEPING) {
    // readTrajectoryBookkeeping(value) accepts precisely this model-free Entry;
    // never reinterpret a Pi message or a legacy top-level event as bookkeeping.
    if (value.model !== undefined || value.head !== undefined || value.edits !== undefined) return undefined;
    const data = record(value.data);
    if (!data) return undefined;
    if (data.type === "event") return withScope(eventFacts(native, data));
    if (data.type === "request") {
      if (!positive(data.taskId) || typeof data.dispatchedAt !== "number"
        || !Number.isSafeInteger(data.dispatchedAt) || data.dispatchedAt < 0
        || (data.purpose !== "generation" && data.purpose !== "compaction")
        || !["streamSimple", "completeSimple", "fetchDeferred"].includes(String(data.method))
        || !text(record(data.model)?.provider) || !text(record(data.model)?.modelId)
        || !text(record(data.model)?.api) || !record(data.options)) return undefined;
      return withScope([{ type: "request", id: nativeKey(native, data.taskId as number),
        purpose: data.purpose ?? null, timestamp: data.dispatchedAt as number }]);
    }
    if (data.type === "hook") {
      if (!positive(data.taskId) || !text(data.extension)
        || !["beforeRequest", "afterResponse", "onYield", "afterTools", "beforeTool", "afterTool", "beforeCompact"]
          .includes(String(data.hook))
        || !["change", "decision", "error"].includes(String(record(data.result)?.type))
        || !nonnegative(data.startedAt) || !nonnegative(data.endedAt)
        || data.startedAt > data.endedAt) return undefined;
      return withScope([{ type: "hook", id: nativeKey(native, value.id as number),
        hook: data.hook ?? null, taskId: nativeKey(native, data.taskId as number),
        toolCallId: text(data.toolCallId) ? nativeKey(native, data.toolCallId as string) : null,
        timestamp: data.startedAt ?? null, durationMs: typeof data.endedAt === "number"
          && typeof data.startedAt === "number" ? data.endedAt - data.startedAt : null,
        outcome: record(data.result)?.type ?? null }]);
    }
    return undefined;
  }
  return withScope(messageFacts(native, value));
}
