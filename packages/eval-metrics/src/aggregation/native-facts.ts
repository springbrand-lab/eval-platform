import { createHash } from "node:crypto";
import { canonicalJsonBytes, jsonObjectInPlaceSchema, type JsonValue } from "@eval-platform/eval-contracts";
import {
  PI_TRAJECTORY_FORMAT, parseSafeTrajectoryRecord, readTrajectoryBookkeeping, trajectoryRecordIdentity,
  type NativeTrajectoryAssistant, type NativeTrajectoryMessage,
} from "@eval-platform/eval-runtime/harness";
import { z } from "zod";
import { containsHiddenTelemetry, contentMarkers, telemetryBodyLength } from "./telemetry-content.js";

export const TELEMETRY_PROJECTION_VERSION = 6;
export const nativeSnapshotProjectionSchema = z.strictObject({
  version: z.literal(TELEMETRY_PROJECTION_VERSION), sourceFormat: z.literal(PI_TRAJECTORY_FORMAT),
  scopeFingerprint: z.string().regex(/^[0-9a-f]{64}$/u), complete: z.boolean(), diagnostics: z.array(z.string()),
});
const resource = z.object({ agentId: z.string(), sessionId: z.string() });
const usage = jsonObjectInPlaceSchema;
const duration = z.number().nullable();
const assistantSchema = z.object({
  role: z.literal("assistant"), provider: z.string(), model: z.string(), timestamp: z.number(),
  durationMs: duration, stopReason: z.string(), usage,
  hasThinking: z.boolean(), hasContent: z.boolean(), thinkingKnown: z.boolean(), contentKnown: z.boolean(),
  calls: z.array(z.object({ id: z.string(), name: z.string(), inputLength: duration })),
});
const toolSchema = z.object({
  role: z.literal("toolResult"), toolCallId: z.string(), toolName: z.string(), timestamp: z.number(),
  durationMs: duration, isError: z.boolean(), outputLength: duration, usage: usage.optional(),
  nestedComplete: z.boolean(),
  nestedCalls: z.array(z.object({
    id: z.string(), name: z.string(), status: z.enum(["ok", "error", "unfinished"]),
    durationMs: duration, inputLength: duration,
  })),
});
const bookkeepingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("request_start"), requestId: z.string(), taskId: z.number(), attempt: z.number(),
    method: z.string(), startedAt: z.number() }),
  z.object({ type: z.literal("request"), requestId: z.string(), taskId: z.number(), attempt: z.number(),
    purpose: z.enum(["generation", "compaction"]), method: z.string(), dispatched: z.boolean(), startedAt: z.number(),
    model: z.object({ provider: z.string(), modelId: z.string(), api: z.string() }) }),
  z.object({ type: z.literal("request_end"), requestId: z.string(), taskId: z.number(), endedAt: z.number(),
    result: z.enum(["entry", "response", "error", "aborted", "interrupted"]),
    outcome: z.enum(["unknown", "not_dispatched"]).optional(),
    entryId: z.number().optional(), response: assistantSchema.optional() }),
  z.object({ type: z.literal("host_turn"), phase: z.enum(["admitted", "running", "parked", "terminal"]),
    recordedAt: z.number(), status: z.enum(["completed", "aborted", "skipped", "error"]).optional() }),
]);
export const nativeMetricSchema = z.object({
  sourceIdentity: z.string().min(1), resource, submissionId: z.string().min(1).nullable(), origin: z.enum(["execution", "context"]),
  selected: z.boolean(),
  parent: z.object({ resource, submissionId: z.string(), toolCallId: z.string().optional() }).optional(),
  recordType: z.enum(["conversation", "entry"]), id: z.number(), conversationId: z.number().optional(),
  kind: z.string().optional(), taskId: z.number().optional(), bookkeeping: bookkeepingSchema.optional(),
  messages: z.array(z.discriminatedUnion("role", [assistantSchema, toolSchema])),
});
export type NativeMetricRecord = z.infer<typeof nativeMetricSchema>;
export type NativeAssistantMetric = z.infer<typeof assistantSchema>;

function assistantMetric(message: NativeTrajectoryAssistant): NativeAssistantMetric {
  const body = jsonObjectInPlaceSchema.parse(message);
  const markers = contentMarkers(body);
  const bodyKnown = !containsHiddenTelemetry(body);
  return {
    role: "assistant", provider: message.provider, model: message.model, timestamp: message.timestamp,
    durationMs: message.durationMs ?? null, stopReason: message.stopReason, usage: jsonObjectInPlaceSchema.parse(message.usage),
    hasThinking: markers.thinking, hasContent: markers.content,
    thinkingKnown: markers.thinking || bodyKnown, contentKnown: markers.content || bodyKnown,
    calls: message.content.flatMap((block) => block.type === "toolCall"
      ? [{ id: block.id, name: block.name, inputLength: telemetryBodyLength(block.arguments) }] : []),
  };
}

function messageMetric(message: NativeTrajectoryMessage): NativeMetricRecord["messages"] {
  if (message.role === "assistant") return [assistantMetric(message)];
  if (message.role !== "toolResult") return [];
  return [{
    role: "toolResult", toolCallId: message.toolCallId, toolName: message.toolName, timestamp: message.timestamp,
    durationMs: message.durationMs ?? null, isError: message.isError,
    outputLength: telemetryBodyLength(jsonObjectInPlaceSchema.parse({ content: message.content, ...(message.details === undefined ? {} : { details: message.details }) })),
    ...(message.usage === undefined ? {} : { usage: jsonObjectInPlaceSchema.parse(message.usage) }),
    nestedComplete: message.nestedCalls?.complete ?? true,
    nestedCalls: (message.nestedCalls?.calls ?? []).map((call) => ({
      id: call.id, name: call.name, status: call.status, durationMs: call.durationMs ?? null,
      inputLength: call.arguments === undefined ? call.argumentsBytes ?? null : telemetryBodyLength(call.arguments),
    })),
  }];
}

export function projectNativeRecord(value: unknown, selected: boolean): NativeMetricRecord {
  const record = parseSafeTrajectoryRecord(value);
  const source: NativeMetricRecord = {
    sourceIdentity: trajectoryRecordIdentity(record), resource: record.resource, submissionId: record.submissionId,
    origin: record.origin ?? "execution", selected,
    ...(record.parent ? { parent: { resource: record.parent.resource, submissionId: record.parent.submissionId,
      ...(record.parent.toolCallId === undefined ? {} : { toolCallId: record.parent.toolCallId }) } } : {}),
    recordType: record.record.type, id: record.record.value.id, messages: [],
  };
  if (record.record.type !== "entry") return source;
  const entry = record.record.value;
  const data = readTrajectoryBookkeeping(entry);
  let bookkeeping: NativeMetricRecord["bookkeeping"];
  if (data?.type === "request_start") bookkeeping = {
    type: data.type, requestId: data.requestId, taskId: data.taskId, attempt: data.attempt,
    method: data.binding.method, startedAt: data.startedAt,
  };
  else if (data?.type === "request") bookkeeping = {
    type: data.type, requestId: data.requestId, taskId: data.taskId, attempt: data.attempt, purpose: data.purpose,
    method: data.method, dispatched: data.dispatched, startedAt: data.startedAt, model: data.model,
  };
  else if (data?.type === "request_end") bookkeeping = {
    type: data.type, requestId: data.requestId, taskId: data.taskId, endedAt: data.endedAt, result: data.result.type,
    ...(data.result.type === "entry" ? { entryId: data.result.entryId } : {}),
    ...(data.result.type === "response" ? { response: assistantMetric(data.result.message) } : {}),
    ...(data.result.type === "interrupted" ? { outcome: data.result.outcome } : {}),
  };
  else if (data?.type === "host_turn") bookkeeping = {
    type: data.type, phase: data.phase, recordedAt: data.recordedAt, ...(data.phase === "terminal" ? { status: data.status } : {}),
  };
  return {
    ...source, conversationId: entry.conversationId, kind: entry.kind,
    ...(entry.byTaskId === undefined ? {} : { taskId: entry.byTaskId }),
    ...(bookkeeping ? { bookkeeping } : {}), messages: (entry.model ?? []).flatMap(messageMetric),
  };
}

export function telemetryFingerprint(value: Readonly<Record<string, JsonValue>>): string {
  const { ingestSeq: _seq, ...source } = value;
  return createHash("sha256").update(canonicalJsonBytes(value.format === PI_TRAJECTORY_FORMAT ? source : value)).digest("hex");
}
