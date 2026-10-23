import {
  PI_TRAJECTORY_FORMAT,
  openTrajectory,
  parseTrajectoryRecord,
  readTrajectoryBookkeeping,
  trajectoryRecordIdentity,
  type NativeTrajectoryWrite,
  type TrajectoryRecord,
  type TrajectoryRequestEndData,
} from "@springbrand/eval-harness";
import { z } from "zod";
import { equalJson } from "@eval-platform/eval-contracts";
import { belongsToNativeExecution, distinctNativeRecords, nativeExecutionKey, openNativeExecution, type NativeExecutionScope } from "./native-execution.js";

export {
  PI_TRAJECTORY_FORMAT, openTrajectory, parseTrajectoryRecord, readTrajectoryBookkeeping, trajectoryRecordIdentity,
};
export { isEvalTrajectoryDelivered } from "@springbrand/eval-harness";
export type {
  NativeTrajectoryWrite, TrajectoryBookkeepingData, TrajectoryRecord, TrajectoryResource, TrajectoryDeliveryState,
} from "@springbrand/eval-harness";
export type NativeTrajectoryEntry = Extract<NativeTrajectoryWrite, { type: "entry" }>["value"];
export type NativeTrajectoryMessage = NonNullable<NativeTrajectoryEntry["model"]>[number];
export type NativeTrajectoryAssistant = Extract<NativeTrajectoryMessage, { role: "assistant" }>;
export type NativeTrajectoryToolResult = Extract<NativeTrajectoryMessage, { role: "toolResult" }>;

export const HISTORICAL_SP_TRAJECTORY_FORMAT = "sp-trajectory/v1" as const;
export type StoredTrajectoryFormat = typeof PI_TRAJECTORY_FORMAT | typeof HISTORICAL_SP_TRAJECTORY_FORMAT;

export class TrajectoryFormatError extends Error {
  readonly retryable = false;
  constructor(format: unknown) {
    super(`Unsupported trajectory format: ${String(format)}`);
    this.name = "TrajectoryFormatError";
  }
}

/** Missing markers are meaningful only on already persisted resource snapshots. */
export function storedTrajectoryFormat(format: string | undefined): StoredTrajectoryFormat {
  if (format === undefined || format === HISTORICAL_SP_TRAJECTORY_FORMAT) return HISTORICAL_SP_TRAJECTORY_FORMAT;
  if (format === PI_TRAJECTORY_FORMAT) return format;
  throw new TrajectoryFormatError(format);
}

export type TrajectoryCategory = "turn" | "generation" | "tool" | "approval" | "interaction" | "subagent" | "context" | "other";
export interface TrajectoryRecordDescription {
  readonly category: TrajectoryCategory;
  readonly type: string;
  readonly occurredAt: number | null;
  readonly models: readonly string[];
  readonly tools: readonly string[];
  readonly summary: string;
  readonly failed: boolean;
}

export function describeTrajectoryRecord(record: TrajectoryRecord, related: readonly TrajectoryRecord[] = []): TrajectoryRecordDescription {
  const base: TrajectoryRecordDescription = {
    category: "other", type: record.record.type, occurredAt: null, models: [], tools: [], summary: "", failed: false,
  };
  if (record.record.type === "conversation") {
    return { ...base, category: "context", summary: `Conversation ${record.record.value.id}` };
  }
  const entry = record.record.value;
  const data = readTrajectoryBookkeeping(entry);
  if (data) {
    if (record.origin === "context") return {
      ...base, category: "context", type: data.type, summary: `Imported context · ${data.type}`,
      occurredAt: "recordedAt" in data ? data.recordedAt : "startedAt" in data ? data.startedAt : "endedAt" in data ? data.endedAt : null,
    };
    switch (data.type) {
      case "request_start":
        return { ...base, category: "context", type: data.type, occurredAt: data.startedAt,
          summary: `${data.requestId} · preparation · ${data.binding.method}` };
      case "request":
        return { ...base, category: data.purpose === "compaction" ? "context" : "generation", type: data.method === "fetchDeferred" ? "request.poll" : data.type,
          occurredAt: data.startedAt, models: [data.model.modelId],
          summary: `${data.method === "fetchDeferred" ? "poll" : data.purpose} · ${data.model.modelId} · attempt ${data.attempt}${data.dispatched ? "" : " · not dispatched"}` };
      case "request_end": {
        const requestRecord = related.find((candidate) => {
          if (!equalJson(candidate.resource, record.resource) || candidate.submissionId !== record.submissionId || candidate.record.type !== "entry") return false;
          const request = readTrajectoryBookkeeping(candidate.record.value);
          return request?.type === "request" && request.requestId === data.requestId;
        });
        const request = requestRecord?.record.type === "entry" ? readTrajectoryBookkeeping(requestRecord.record.value) : undefined;
        return { ...base, category: request?.type === "request" && request.purpose === "compaction" ? "context" : "generation",
          models: request?.type === "request" ? [request.model.modelId] : [],
          type: data.type, occurredAt: data.endedAt,
          failed: data.result.type === "error" || data.result.type === "aborted" || data.result.type === "interrupted",
          summary: `${data.requestId} · ${data.result.type}${data.result.type === "error" ? ` · ${data.result.error.message}` : ""}` };
      }
      case "host_turn":
        return { ...base, category: data.phase === "parked" && data.reason !== "slice" ? data.reason : "turn",
          type: `host_turn.${data.phase}`, occurredAt: data.recordedAt,
          failed: data.phase === "terminal" && data.status !== "completed",
          summary: `${data.submissionId} · ${data.phase === "terminal" ? data.status : data.phase}` };
      case "host_child":
        return { ...base, category: "subagent", type: data.type, occurredAt: data.recordedAt,
          summary: `${data.launchId} · ${data.disposition} · ${data.child.className} · ${data.child.name}` };
      case "approval_decision":
        return { ...base, category: "approval", type: data.type, occurredAt: data.decidedAt,
          summary: `${data.toolName} · ${data.decision}`, failed: data.status === "rejected" };
      case "attribution":
        return { ...base, category: "context", type: data.type, summary: data.origin };
      case "input":
        return { ...base, category: "context", type: data.type, occurredAt: data.recordedAt, summary: data.source };
      case "hook":
        return { ...base, type: `hook.${data.hook}`, occurredAt: data.startedAt, summary: data.extension,
          failed: data.result.type === "error" };
    }
  }
  const messages = entry.model ?? [];
  const tools = messages.flatMap((message) => message.role === "toolResult" ? [message.toolName]
    : message.role === "assistant" ? message.content.flatMap((block) => block.type === "toolCall" ? [block.name] : []) : []);
  const models = messages.flatMap((message) => message.role === "assistant" ? [message.model] : []);
  const failed = messages.some((message) => message.role === "toolResult" ? message.isError
    : message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"));
  const category: TrajectoryCategory = record.origin === "context" || entry.kind === "pi.compaction" || entry.head !== undefined || entry.edits
    ? "context" : models.length > 0 ? "generation" : tools.length > 0 ? "tool" : messages.length > 0 ? "context" : "other";
  const summaries = [...tools.map((name) => `工具 ${name}`), ...models.map((name) => `模型 ${name}`)];
  return { ...base, type: entry.kind, category, occurredAt: messages.at(-1)?.timestamp ?? null,
    tools: [...new Set(tools)], models: [...new Set(models)], failed,
    summary: summaries.join(" · ") };
}

export async function readNativeFinalReply(
  values: readonly unknown[], scope: NativeExecutionScope,
): Promise<string | undefined> {
  const execution = await openNativeExecution(values, [scope]);
  try {
    if (!execution.complete) return undefined;
    const visible = execution.visible.get(nativeExecutionKey(scope)) ?? [];
    const terminal = visible.find((record) => {
      const data = record.record.type === "entry" ? readTrajectoryBookkeeping(record.record.value) : undefined;
      return data?.type === "host_turn" && data.phase === "terminal" && data.status === "completed";
    });
    if (!terminal || terminal.record.type !== "entry") return undefined;
    const conversationId = terminal.record.value.conversationId;
    const root = execution.records.filter((record) => belongsToNativeExecution(record, scope) &&
      record.record.type === "entry" && record.record.value.conversationId === conversationId);
    const ends = new Map<string, TrajectoryRequestEndData>();
    for (const record of root) {
      const data = record.record.type === "entry" ? readTrajectoryBookkeeping(record.record.value) : undefined;
      if (data?.type === "request_end") ends.set(data.requestId, data);
    }
    const requests = execution.reader.requests({ resource: scope.resource, submissionId: scope.submissionId })
      .filter(({ record }) => record.record.type === "entry" && record.record.value.conversationId === conversationId);
    const candidates = requests.flatMap(({ data }) => {
      const end = ends.get(data.requestId);
      if (data.purpose !== "generation" || data.cutoff === null || !data.dispatched || end?.result.type !== "entry") return [];
      const responseId = end.result.entryId;
      const position = visible.findIndex((record) => record.record.type === "entry" && record.record.value.id === responseId);
      return position < 0 ? [] : [{ requestId: data.requestId, responseId, position }];
    });
    const candidate = candidates.sort((left, right) => left.position - right.position).at(-1);
    if (!candidate) return undefined;
    const sealed = new Set(requests.map(({ data }) => data.requestId));
    for (const record of root) {
      if (record.record.type !== "entry") continue;
      const data = readTrajectoryBookkeeping(record.record.value);
      if (!(data?.type === "request_start" && data.cutoff !== null && !sealed.has(data.requestId) ||
        data?.type === "request" && data.cutoff !== null && data.purpose === "generation" && data.requestId !== candidate.requestId)) continue;
      // Only context-bound preparations/dispatches can supersede the primary reply.
      // Ask Pi about visibility; unbound calls have no canonical binding, even in the same task.
      const context = await execution.reader.context({ resource: scope.resource, conversationId, at: record.record.value.id });
      if (context.entries.some((entry) => entry.id === candidate.responseId)) return undefined;
    }
    const view = await execution.reader.request({ resource: scope.resource, requestId: candidate.requestId });
    const response = view.response;
    if (!response || response.stopReason !== "stop" && response.stopReason !== "length") return undefined;
    const text = response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    return text.trim() === "" ? undefined : text;
  } finally {
    await execution.close();
  }
}

/** On-demand audit inspection. Canonical Pi conversation context is not a replay of model input. */
export async function readNativeRecordDetail(values: readonly unknown[], record: TrajectoryRecord): Promise<unknown> {
  if (record.record.type !== "entry") return undefined;
  const entry = record.record.value;
  const data = readTrajectoryBookkeeping(entry);
  if (!data || data.type === "attribution" || data.type === "host_turn" || data.type === "host_child") return undefined;
  if (data.type === "approval_decision") return { approval: data };
  const reader = await openTrajectory(distinctNativeRecords(values));
  try {
    if (data.type === "hook" && data.result.type === "change") {
      return await reader.hook({ resource: record.resource, entryId: entry.id });
    }
    if (data.type === "input" || data.type === "hook" && data.result.type === "input") {
      return { change: data };
    }
    if (data.type === "hook") return { hook: data };
    if (data.requestId === undefined) return undefined;
    const request = reader.requests({ resource: record.resource }).find((request) => request.data.requestId === data.requestId);
    if (request) {
      const view = await reader.request({ resource: record.resource, requestId: data.requestId });
      return { request: view.data, canonicalContext: view.context, steps: view.steps,
        ...(view.end ? { end: view.end } : {}), ...(view.response ? { response: view.response } : {}) };
    }
    const start = reader.preparations({ resource: record.resource }).find((start) => start.data.requestId === data.requestId);
    if (!start || start.record.record.type !== "entry") return undefined;
    const context = start.data.cutoff === null ? null : await reader.context({
      resource: record.resource, conversationId: start.record.record.value.conversationId, at: start.data.cutoff,
    });
    return { preparation: start.data, canonicalContext: context };
  } finally {
    await reader.close();
  }
}

const archivedTurnSchema = z.object({
  type: z.literal("turn.finished"),
  payload: z.object({ output: z.object({
    role: z.literal("assistant"), content: z.array(z.looseObject({ type: z.string(), text: z.unknown().optional() })),
  }) }),
});

export function readArchivedFinalReply(format: string, values: readonly unknown[]): string | undefined {
  if (format !== HISTORICAL_SP_TRAJECTORY_FORMAT) throw new Error("The historical reply reader requires sp-trajectory/v1");
  let reply: string | undefined;
  for (const value of values) {
    const event = value !== null && typeof value === "object" && "event" in value ? value.event : value;
    const parsed = archivedTurnSchema.safeParse(event);
    if (!parsed.success) continue;
    const text = parsed.data.payload.output.content
      .flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
    if (text.trim()) reply = text;
  }
  return reply;
}
