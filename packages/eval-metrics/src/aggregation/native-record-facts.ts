import {
  canonicalJsonBytes, NATIVE_TOOL_CALL_KEY_PREFIX, type JsonValue, type PiTrajectoryRecordView,
} from "@eval-platform/eval-contracts";
import sha256 from "fast-sha256";
import { record, text, type JsonRecord } from "../json.js";

/**
 * A deliberately narrow, body-free adapter for the *published UA* TrajectoryRecord
 * envelope. The full native record is never converted to an old event. The public
 * `readTrajectoryBookkeeping` defines the public bookkeeping contract. The
 * fixture is checked with that helper; the production adapter retains only
 * focused body-free facts after public native validation at the API seam.
 * An unrecognized fact is unsupported, not evidence of a complete empty stream.
 */
export type NativeMetricFact = JsonRecord;

const BOOKKEEPING = "springbrand.trajectory";
const OUTCOMES = new Set(["completed", "failed", "cancelled"]);
const OTHER_EVENTS = new Set([
  "approval.requested", "approval.decided", "interaction.requested", "interaction.responded",
  "interaction.cancelled", "context.compacted",
]);
/** Versioned internal key shape shared with the SQL consumer; not a raw UA ID grammar. */
export { NATIVE_TOOL_CALL_KEY_PREFIX } from "@eval-platform/eval-contracts";

function exceedsInterpretationBudget(value: JsonValue | undefined): boolean {
  const pending: (JsonValue | undefined)[] = [value];
  let examined = 0;
  while (pending.length > 0) {
    // An unreasonably complex raw Tool value cannot prove an exact length here.
    if (++examined > 10_000) return true;
    const current = pending.pop();
    if (typeof current === "string") {
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    const object = record(current);
    if (object) for (const item of Object.values(object)) pending.push(item);
  }
  return false;
}

/** Byte statistics only for complete raw Pi Tool values. Never read request.options or rebuild a generation input. */
function toolBytes(value: JsonValue | undefined, omitted = false): number | null {
  if (value === undefined || omitted || exceedsInterpretationBudget(value)) return null;
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

/** Public native validation admits the message, but Tool details
 * remain opaque Pi data: only executionId can corroborate a ledger execution. */
function safeIdentity(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length <= 128
    && /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/u.test(value)
    && !/(?:^|[_.:-])(?:secret|token|password|api[_-]?key|bearer)(?:$|[_.:-])/iu.test(value)
    && !/^(?:sk-|key_)/iu.test(value) ? value : undefined;
}

function safeToolName(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length <= 96
    && /^[A-Za-z_][A-Za-z0-9_./:-]*$/u.test(value) && !value.includes("://")
    && !/(?:^|[_.:/-])(?:secret|token|password|api[_-]?key|bearer|private|prompt|credential|authorization)(?:$|[_.:/-])/iu.test(value)
    && !/^(?:sk-|key_|bearer|ghp_|glpat-|xox[baprs]-)/iu.test(value) ? value : null;
}

/** Metrics retain bounded raw source labels; charge links require identifier-shaped names. */
function metricToolName(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length <= 256 && !value.includes("://")
    && !/(?:^|[\s_.:/=-])(?:secret|token|password|api[_-]?key|bearer|private|prompt|credential|authorization)(?:$|[\s_.:/=-])/iu.test(value)
    && !/^(?:sk-|key_|bearer|ghp_|glpat-|xox[baprs]-)/iu.test(value) ? value : null;
}

/** Native IDs, not telemetry event IDs: a temporary Agent and another Submission cannot collide. */
function nativeKey(source: PiTrajectoryRecordView, value: string | number): string {
  return JSON.stringify([source.resource.agentId, source.resource.sessionId, source.submissionId, value]);
}

/** Pi ToolCall.id / ToolResult.toolCallId: UA's native schema accepts any
 * nonempty string, including whitespace and provider composite IDs. Bounded
 * interpretations mark unavailable IDs independently; genuine raw marker strings
 * are IDs. Do not persist even a credential-shaped *valid* source ID:
 * every Tool operation and Action link uses this same scoped digest instead. */
function piToolCallKey(source: PiTrajectoryRecordView, value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  // JSON.stringify is injective for JS strings (including isolated surrogates).
  // TextEncoder(value) alone would conflate a lone surrogate with U+FFFD.
  const bytes = new TextEncoder().encode(JSON.stringify([
    "eval-platform.pi-tool-call-id/v2", source.resource.agentId, source.resource.sessionId, source.submissionId, value,
  ]));
  return `${NATIVE_TOOL_CALL_KEY_PREFIX}${[...sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function parentTurn(source: PiTrajectoryRecordView, event: JsonRecord): string | null {
  return text(event.parentOperationId) ? nativeKey(source, event.parentOperationId as string) : null;
}

function flags(content: JsonValue | undefined): { thinking: boolean | null; content: boolean | null } {
  if (!Array.isArray(content)) return { thinking: null, content: null };
  const blocks = content.map(record);
  if (blocks.some((block) => !text(block?.type))) return { thinking: null, content: null };
  const thinking = blocks.some((block) => block!.type === "thinking" ||
    Object.keys(block!).some((key) => key.toLowerCase().endsWith("signature")));
  const textBlock = blocks.some((block) => block!.type === "text");
  // Native block identities describe categories separately from values. A provider-native
  // opaque block cannot prove the absence of either category.
  const opaque = blocks.some((block) => block!.type === "providerNative");
  return { thinking: thinking || !opaque ? thinking : null, content: textBlock || !opaque ? textBlock : null };
}

function eventFacts(source: PiTrajectoryRecordView, data: JsonRecord): readonly NativeMetricFact[] | undefined {
  const event = record(data.event);
  const payload = record(event?.payload);
  if (!event || !payload || event.schemaVersion !== 1 || !text(event.eventId)
    || !text(event.operationId) || !Number.isSafeInteger(event.occurredAt)
    || (typeof event.occurredAt === "number" && event.occurredAt < 0)
    || record(event.resource)?.sessionId !== source.resource.sessionId
    || record(event.resource)?.agentId !== source.resource.agentId
    || event.submissionId !== source.submissionId
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
      durationMs: metricNumber(payload.durationMs), eventId: event.eventId ?? null }];
  }
  if (event.type === "generation.started" || event.type === "generation.finished") {
    if (!text(payload.generationId)) return undefined;
    return [{ type: "model", phase: event.type === "generation.started" ? "start" : "end",
      id: op, turnId: parentTurn(source, event), timestamp: occurredAt,
      status: event.type === "generation.finished" ? payload.outcome ?? null : null,
      durationMs: metricNumber(payload.durationMs),
      assistantTimestamp: metricNumber(record(data.refs)?.assistantTimestamp),
      inputTokens: metricNumber(payload.inputTokens), outputTokens: metricNumber(payload.outputTokens),
      totalTokens: metricNumber(payload.totalTokens), eventId: event.eventId ?? null }];
  }
  if (event.type === "tool.started" || event.type === "tool.finished") {
    if (!text(payload.toolName)) return undefined;
    const callKey = piToolCallKey(source, event.toolCallId);
    return [{ type: "tool", phase: event.type === "tool.started" ? "start" : "end",
      id: callKey ? nativeKey(source, callKey) : null, turnId: parentTurn(source, event),
      toolName: metricToolName(payload.toolName), timestamp: occurredAt,
      status: event.type === "tool.finished" ? payload.outcome ?? null : null,
      durationMs: metricNumber(payload.durationMs), fromEvent: true, eventId: event.eventId ?? null,
      // `input`/`output` are intentionally absent from UA event facts: Pi owns them.
    }];
  }
  // A subagent may execute more generations/Tools than this parent event shows.
  // Until actual scoped child delivery is proven, it cannot establish their absence.
  return OTHER_EVENTS.has(String(event.type)) ? [] : undefined;
}

function metricNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function messageFacts(source: PiTrajectoryRecordView, native: JsonRecord,
  omittedPaths: readonly string[]): readonly NativeMetricFact[] | undefined {
  const missing = (path: string) => omittedPaths.some((omitted) => path === omitted || path.startsWith(`${omitted}/`));
  const incomplete = (path: string) => missing(path) || omittedPaths.some((omitted) => omitted.startsWith(`${path}/`));
  const messagePath = "/record/value/model/0";
  const read = (value: JsonValue | undefined, path: string) => missing(path) ? undefined : value;
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
      const markers = incomplete(`${messagePath}/content`)
        ? { thinking: null, content: null } : flags(message.content);
      facts.push({ type: "assistant", id: nativeKey(source, native.id as number),
        timestamp: message.timestamp, taskId: positive(native.byTaskId) ? nativeKey(source, native.byTaskId) : null,
        thinking: markers.thinking, content: markers.content,
        inputTokens: metricNumber(read(record(message.usage)?.input, `${messagePath}/usage/input`)),
        outputTokens: metricNumber(read(record(message.usage)?.output, `${messagePath}/usage/output`)),
        totalTokens: metricNumber(read(record(message.usage)?.totalTokens, `${messagePath}/usage/totalTokens`)) });
      for (const [index, blockValue] of message.content.entries()) {
        const block = record(blockValue);
        const blockPath = `${messagePath}/content/${index}`;
        if (read(block?.type, `${blockPath}/type`) !== "toolCall" || !block) continue;
        const callKey = piToolCallKey(source, read(block.id, `${blockPath}/id`));
        const name = read(block.name, `${blockPath}/name`);
        const linkName = safeToolName(name);
        const agentId = safeIdentity(source.resource.agentId);
        const submissionId = safeIdentity(source.submissionId);
        facts.push({ type: "tool", phase: "start", id: callKey ? nativeKey(source, callKey) : null,
          toolName: metricToolName(name), timestamp: message.timestamp,
          ...(native.kind === "pi.assistant" && callKey && linkName && agentId && submissionId
            ? { agentId, submissionId, toolCallKey: callKey } : {}),
          inputLength: toolBytes(block.arguments, incomplete(`${blockPath}/arguments`)), fromPiCall: true });
      }
      continue;
    }
    if (message.role === "toolResult") {
      if (!Array.isArray(message.content)) return undefined;
      const callKey = piToolCallKey(source, read(message.toolCallId, `${messagePath}/toolCallId`));
      const name = read(message.toolName, `${messagePath}/toolName`);
      const linkName = safeToolName(name);
      const agentId = safeIdentity(source.resource.agentId);
      const submissionId = safeIdentity(source.submissionId);
      const linkable = (native.kind === "pi.tool-result" || native.kind === "pi.toolResult")
        && callKey && linkName && agentId && submissionId;
      const details = record(message.details);
      const executionId = linkable ? safeIdentity(read(details?.executionId, `${messagePath}/details/executionId`)) : undefined;
      facts.push({ type: "tool", phase: "result", id: callKey ? nativeKey(source, callKey) : null,
        toolName: metricToolName(name), timestamp: message.timestamp,
        ...(linkable ? { agentId, submissionId, toolCallKey: callKey } : {}),
        ...(executionId ? { executionId } : {}),
        status: missing(`${messagePath}/isError`) ? null
          : message.isError === true ? "failed" : message.isError === false ? "completed" : null,
        durationMs: metricNumber(read(message.durationMs, `${messagePath}/durationMs`)),
        outputLength: toolBytes(message.content, incomplete(`${messagePath}/content`)), fromPiResult: true });
    } else if ((message.role !== "user" && message.role !== "system")
      || (native.kind !== "pi.user" && native.kind !== "pi.system")) return undefined;
  }
  return facts;
}

/** Focused extraction of *actual* raw Pi records. Bookkeeping request/hook facts
 * are auxiliary, not replacements for generation/tool terminal events or Pi messages. */
export function nativeRecordFacts(native: PiTrajectoryRecordView,
  omittedPaths: readonly string[] = []): readonly NativeMetricFact[] | undefined {
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
    if (!data || omittedPaths.some((path) => path === "/record/value/data"
      || path.startsWith("/record/value/data/"))) return undefined;
    if (data.type === "reminder") return [];
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
      const callKey = piToolCallKey(native, data.toolCallId);
      return withScope([{ type: "hook", id: nativeKey(native, value.id as number),
        hook: data.hook ?? null, taskId: nativeKey(native, data.taskId as number),
        toolCallId: callKey ? nativeKey(native, callKey) : null,
        timestamp: data.startedAt ?? null, durationMs: typeof data.endedAt === "number"
          && typeof data.startedAt === "number" ? data.endedAt - data.startedAt : null,
        outcome: record(data.result)?.type ?? null }]);
    }
    return undefined;
  }
  return withScope(messageFacts(native, value, omittedPaths));
}
