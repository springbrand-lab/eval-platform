import {
  PI_TRAJECTORY_RECORD_FORMAT, canonicalJsonBytes, type JsonValue, type PiTrajectoryRecord,
} from "@eval-platform/eval-contracts";
import { record, text, type JsonRecord } from "../json.js";

/**
 * An Eval-only adapter at the *public* Pi trajectory seam. These are facts observable in a safe
 * event/request/hook/message/result record, not a parser for UA's events or a reconstruction of
 * the model's generation input. Missing, sanitized and otherwise unknown data stays null.
 */
export type NativeMetricFact = JsonRecord;

const HIDDEN = new Set(["[REDACTED]", "[CONTENT OMITTED]", "[Action business data withheld from telemetry]"]);

function hidden(value: JsonValue | undefined): boolean {
  if (typeof value === "string") return HIDDEN.has(value);
  if (Array.isArray(value)) return value.some(hidden);
  const object = record(value);
  return object !== undefined && (object.redacted === true || Object.values(object).some(hidden));
}

/** Canonical JSON UTF-8 bytes only for an actual, unsanitized Tool body; never for generation input. */
function toolBytes(value: JsonValue | undefined): number | null {
  return value === undefined || value === null || hidden(value) ? null : canonicalJsonBytes(value).byteLength;
}

function time(source: JsonRecord, outer: PiTrajectoryRecord): JsonValue {
  return source.timestamp ?? outer.timestamp ?? null;
}

function status(value: JsonValue | undefined): JsonValue {
  return value === "completed" || value === "failed" || value === "cancelled" ? value : null;
}

function nativeMessageFlags(content: JsonValue | undefined, complete: boolean): { thinking: boolean | null; content: boolean | null } {
  if (!Array.isArray(content)) return { thinking: null, content: null };
  const blocks = content.map(record);
  if (blocks.some((block) => block === undefined || !text(block.type))) return { thinking: null, content: null };
  const hasThinking = blocks.some((block) => block!.type === "thinking" || block!.signature !== undefined
    || Object.keys(block!).some((key) => key.toLowerCase().endsWith("signature")));
  const hasContent = blocks.some((block) => block!.type === "text");
  return {
    thinking: hasThinking ? true : complete ? false : null,
    content: hasContent ? true : complete ? false : null,
  };
}

function stopStatus(value: JsonValue | undefined): JsonValue {
  if (value === "stop" || value === "toolUse") return "completed";
  if (value === "error") return "failed";
  if (value === "aborted") return "cancelled";
  return null;
}

/** Fact extraction returns undefined for an unsupported shape: the caller must mark coverage
 * partial, not manufacture an empty stream (and a false complete zero). */
export function nativeRecordFacts(source: JsonRecord): readonly NativeMetricFact[] | undefined {
  if (source.format !== PI_TRAJECTORY_RECORD_FORMAT || record(source.projection)?.kind !== "safe") return undefined;
  const native = source as PiTrajectoryRecord;
  const turn = (item: JsonRecord): JsonValue => item.turnId ?? native.turnId ?? null;
  const modelId = (item: JsonRecord): JsonValue => item.requestId ?? native.requestId ?? null;
  const toolId = (item: JsonRecord): JsonValue => item.toolCallId ?? native.toolCallId ?? null;
  if (native.kind === "event") {
    const event = record(native.event);
    if (!event) return undefined;
    switch (event.type) {
      case "turn_start":
        return [{ type: "turn", phase: "start", id: turn(event), timestamp: time(event, native) }];
      case "turn_end":
        return [{ type: "turn", phase: "end", id: turn(event), timestamp: time(event, native),
          status: status(event.outcome), durationMs: event.durationMs ?? null }];
      case "tool_execution_start":
        return [{ type: "tool", phase: "start", id: toolId(event), turnId: turn(event),
          toolName: event.toolName ?? null, timestamp: time(event, native), inputLength: toolBytes(event.args) }];
      case "tool_execution_end":
        return [{ type: "tool", phase: "end", id: toolId(event), turnId: turn(event),
          toolName: event.toolName ?? null, timestamp: time(event, native),
          status: event.isError === true ? "failed" : event.isError === false ? "completed" : status(event.outcome),
          durationMs: event.durationMs ?? null, outputLength: toolBytes(event.result) }];
      case "agent_start":
      case "agent_end":
      case "message_start":
      case "message_update":
      case "message_end":
        return [];
      default:
        return undefined;
    }
  }
  if (native.kind === "request") {
    const request = record(native.request);
    if (!request) return undefined;
    const phase = request.phase === "start" ? "start" : request.phase === "end" ? "end" : undefined;
    if (!phase) return undefined;
    return [{ type: "model", phase, id: modelId(request), turnId: turn(request),
      timestamp: time(request, native), status: phase === "end" ? status(request.outcome) : null,
      durationMs: request.durationMs ?? null, inputTokens: request.inputTokens ?? null,
      outputTokens: request.outputTokens ?? null, totalTokens: request.totalTokens ?? null }];
  }
  if (native.kind === "hook") {
    const hook = record(native.hook);
    if (!hook) return undefined;
    if (hook.name !== "before_model" && hook.name !== "after_model"
      && hook.name !== "before_tool" && hook.name !== "after_tool") return undefined;
    const isModel = hook.name === "before_model" || hook.name === "after_model";
    return [{ type: isModel ? "model" : "tool", phase: hook.name.startsWith("before_") ? "start" : "end",
      id: isModel ? modelId(hook) : toolId(hook), turnId: turn(hook),
      timestamp: time(hook, native), status: status(hook.outcome), durationMs: hook.durationMs ?? null,
      ...(isModel ? {} : { toolName: hook.toolName ?? null }) }];
  }
  if (native.kind === "message") {
    const message = record(native.message);
    if (!message) return undefined;
    if (message.role === "assistant") {
      const usage = record(message.usage);
      // Safe content can omit/redact blocks. Positive block types remain evidence; negative
      // classification needs an explicit completeness assertion from the public projection.
      const contentComplete = record(native.projection)?.contentComplete === true
        && Array.isArray(message.content) && !hidden(message.content);
      const flags = nativeMessageFlags(message.content, contentComplete);
      const model: NativeMetricFact = {
        type: "model", phase: "message", id: modelId(message), turnId: turn(message),
        timestamp: time(message, native), status: stopStatus(message.stopReason),
        contentComplete,
        thinking: flags.thinking, content: flags.content,
        inputTokens: usage?.input ?? usage?.inputTokens ?? null,
        outputTokens: usage?.output ?? usage?.outputTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
      };
      const calls = Array.isArray(message.content) ? message.content.flatMap((item) => {
        const block = record(item);
        return block?.type === "toolCall" ? [{
          type: "tool", phase: "start", id: block.id ?? null, turnId: turn(message),
          toolName: block.name ?? null, timestamp: time(message, native), inputLength: toolBytes(block.arguments),
        }] : [];
      }) : [];
      return [model, ...calls];
    }
    if (message.role === "toolResult") {
      return [{ type: "tool", phase: "result", id: toolId(message), turnId: turn(message),
        toolName: message.toolName ?? null, timestamp: time(message, native),
        status: message.isError === true ? "failed" : message.isError === false ? "completed" : null,
        outputLength: toolBytes(message.content) }];
    }
    if (message.role === "user") {
      return [{ type: "turn", phase: "start", id: turn(message), timestamp: time(message, native) }];
    }
    return undefined;
  }
  if (native.kind === "result") {
    const result = record(native.result);
    if (!result) return undefined;
    if (result.type !== "toolResult") return undefined;
    return [{ type: "tool", phase: "result", id: toolId(result), turnId: turn(result),
      toolName: result.toolName ?? null, timestamp: time(result, native),
      status: result.isError === true ? "failed" : result.isError === false ? "completed" : null,
      durationMs: result.durationMs ?? null,
      outputLength: toolBytes(result.content) }];
  }
  return undefined;
}
