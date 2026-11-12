import type { JsonValue } from "./model.js";
import type { EvalEvidenceTrajectoryPage } from "@springbrand/eval-harness";
import { z } from "zod";
import { jsonObjectInPlaceSchema } from "./json.js";

/** SP's published eval-harness owns HTTP validation; this browser-safe contract
 * describes persisted native facts and bounded stream checks, not the wire authority.
 * No event-only records are native. */
export const SP_PI_TRAJECTORY_FORMAT = "sp-pi-trajectory/v1";
export const PI_TRAJECTORY_RECORD_FORMAT = "pi-trajectory/v1";
export const PI_METRIC_RECORD_FORMAT = "eval-pi-metric-record/v1";
export const NATIVE_PROJECTION_VERSION = 2;
export const NATIVE_CHARGE_LINK_VERSION = 2;
export const NATIVE_TOOL_CALL_KEY_PREFIX = "tck2_";
/** Browser-safe persisted reference shape; the API parses transfers with SP's public schema. */
export const SP_PI_TRAJECTORY_RECORD_FORMAT = "sp-pi-trajectory-record/v1";

/** Minimal structural view of the public UA TrajectoryRecord. `record.value` remains
 * opaque native Pi data: this view is not a full native validator or original evidence. */
export type PiTrajectoryRecordView = {
  readonly resource: { readonly agentId: string; readonly sessionId: string };
  readonly record:
    | { readonly type: "conversation"; readonly value: { readonly id: number } & Readonly<Record<string, JsonValue>> }
    | { readonly type: "entry"; readonly value: {
      readonly id: number; readonly conversationId: number; readonly kind: string;
    } & Readonly<Record<string, JsonValue>> };
  readonly parent?: Readonly<Record<string, JsonValue>>;
} & (
  | { readonly submissionId: string; readonly origin?: "execution" }
  | { readonly submissionId: null; readonly origin: "context" }
);

export type PiTrajectoryRecord = PiTrajectoryRecordView & {
  readonly format: typeof PI_TRAJECTORY_RECORD_FORMAT;
  readonly ingestSeq?: number;
};

export interface NativeTrajectoryInterpretationEntry {
  readonly ingestSeq: number;
  readonly interpretation: {
    readonly record: PiTrajectoryRecordView;
    readonly omittedPaths: readonly string[];
  };
}

export interface CompactNativeTrajectoryEntry {
  readonly ingestSeq: number;
  readonly record: PiTrajectoryRecordView & { readonly format: typeof PI_METRIC_RECORD_FORMAT };
  readonly metricProjection: {
    readonly version: typeof NATIVE_PROJECTION_VERSION;
    readonly chargeLinkVersion: typeof NATIVE_CHARGE_LINK_VERSION;
    readonly fingerprint: string;
    readonly supported: boolean;
    readonly complete: boolean;
    readonly facts: readonly Readonly<Record<string, JsonValue>>[];
  };
}

export type ResourceNativeTrajectoryEntry = NativeTrajectoryEntry | CompactNativeTrajectoryEntry;

/** Source cursor of a single complete native record; not an event ID or an index into a page. */
export interface NativeTrajectoryEntry {
  readonly ingestSeq: number;
  readonly record: PiTrajectoryRecord;
  /** Raw pages cannot supply or impersonate local derived Metrics facts. */
  readonly metricProjection?: never;
}

/** Not a partial native record: its exact serialized raw Pi record must be fetched and verified. */
export interface SpPiTrajectoryRecordReference {
  readonly ingestSeq: number;
  readonly reference: {
    readonly format: typeof SP_PI_TRAJECTORY_RECORD_FORMAT;
    readonly throughSeq: number;
    /** Public UA identity `[agentId, sessionId, "entry"|"conversation", nativeId]`. */
    readonly identity: string;
    /** Exact UTF-8 JSON bytes of `TrajectoryRecord`, excluding the `{ingestSeq,record}` wrapper. */
    readonly byteLength: number;
    readonly sha256: string;
  };
}

export type SpPiTrajectoryPageRow = NativeTrajectoryEntry | SpPiTrajectoryRecordReference;

/** Public Harness page metadata with original, opaque Pi bodies after HTTP validation.
 * This type-only dependency never loads the Harness runtime root in a browser. */
export type SpPiTrajectoryPage = Omit<EvalEvidenceTrajectoryPage, "records"> & {
  readonly records: readonly SpPiTrajectoryPageRow[];
};

/** Local storage/stream guard only; the API HTTP page uses SP's published schema. */
export function isPiTrajectoryRecord(value: unknown): value is PiTrajectoryRecord {
  const item = object(value);
  if (!item || item.format !== PI_TRAJECTORY_RECORD_FORMAT
    || !onlyKeys(item, ["format", "resource", "submissionId", "record", "parent", "origin", "ingestSeq"])
    || ("ingestSeq" in item && !positive(item.ingestSeq))) return false;
  const { format: _format, ingestSeq: _ingestSeq, ...view } = item;
  return isPiTrajectoryRecordView(view);
}

export function isPiTrajectoryRecordView(value: unknown): value is PiTrajectoryRecordView {
  if (!jsonObjectInPlaceSchema.safeParse(value).success) return false;
  const item = value as Record<string, unknown>;
  const resource = object(item.resource);
  const write = object(item.record);
  const native = object(write?.value);
  if (!resource || !name(resource.agentId) || !name(resource.sessionId)
    || !onlyKeys(resource, ["agentId", "sessionId"])
    || !write || (write.type !== "entry" && write.type !== "conversation")
    || !native || !positive(native.id)) return false;
  if (item.submissionId === null) {
    if (item.origin !== "context") return false;
  } else if (!name(item.submissionId) || (item.origin !== undefined && item.origin !== "execution")) {
    return false;
  }
  if (write.type === "entry" && (!positive(native.conversationId) || !name(native.kind)
    || (native.model !== undefined && (!Array.isArray(native.model)
      || native.model.some((message) => !object(message)))))) return false;
  const parent = object(item.parent);
  if (item.parent !== undefined && (!parent
    || !onlyKeys(parent, ["resource", "submissionId", "conversationId", "taskId", "requestId", "toolCallId", "runId"])
    || !object(parent.resource) || !name(object(parent.resource)?.agentId)
    || !name(object(parent.resource)?.sessionId) || !onlyKeys(object(parent.resource)!, ["agentId", "sessionId"])
    || !name(parent.submissionId)
    || ["conversationId", "taskId"].some((key) => parent[key] !== undefined && !positive(parent[key]))
    || ["requestId", "toolCallId", "runId"].some((key) => parent[key] !== undefined && !name(parent[key])))) return false;
  // Interpretation views have no cursor; SP's row guard separately rejects an inner ingestSeq.
  return onlyKeys(item, ["resource", "submissionId", "record", "parent", "origin"])
    && onlyKeys(write, ["type", "value"]);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function name(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Parse one canonical, public UA identity without treating a foreign Chat as this one. */
export function spPiTrajectoryIdentityParts(identity: string):
  readonly [agentId: string, sessionId: string, kind: "entry" | "conversation", id: number] | null {
  try {
    const parts: unknown = JSON.parse(identity);
    if (!Array.isArray(parts) || parts.length !== 4 || !name(parts[0]) || !name(parts[1])
      || (parts[2] !== "entry" && parts[2] !== "conversation") || !positive(parts[3])
      || JSON.stringify(parts) !== identity) return null;
    return parts as [string, string, "entry" | "conversation", number];
  } catch {
    return null;
  }
}

export function spPiTrajectoryRecordIdentity(record: PiTrajectoryRecordView): string {
  return JSON.stringify([record.resource.agentId, record.resource.sessionId, record.record.type, record.record.value.id]);
}

const sequence = z.number().int().positive().safe();
export const spPiTrajectoryReferenceSchema: z.ZodType<SpPiTrajectoryRecordReference> = z.strictObject({
  ingestSeq: sequence,
  reference: z.strictObject({
    format: z.literal(SP_PI_TRAJECTORY_RECORD_FORMAT),
    throughSeq: z.number().int().nonnegative().safe(),
    identity: z.string().min(1).refine((value) => spPiTrajectoryIdentityParts(value) !== null, "Invalid native identity"),
    byteLength: sequence,
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
}).superRefine(({ ingestSeq, reference }, context) => {
  if (ingestSeq > reference.throughSeq) {
    context.addIssue({ code: "custom", path: ["reference", "throughSeq"], message: "Record is after the cutoff" });
  }
});
export function isSpPiTrajectoryReference(value: SpPiTrajectoryPageRow): value is SpPiTrajectoryRecordReference {
  return "reference" in value;
}

/** SP scopes the resource pages to one Submission and attributed children. A
 * descendant's parent is proof only when that Submission was already verified in
 * this ordered page stream; an arbitrary foreign parent is not authorization.
 * Child Context (null Submission) is in scope only with such a parent. */
export function nativeRecordMayBelongToScope(
  value: PiTrajectoryRecordView, scope: { readonly chatId: string; readonly submissionId: string },
  verifiedSubmissions?: ReadonlySet<string>,
): boolean {
  const parent = object(value.parent);
  if (value.resource.sessionId !== scope.chatId ||
    (parent && object(parent.resource)?.sessionId !== scope.chatId)) return false;
  if (value.submissionId === scope.submissionId) return true;
  return parent !== undefined && (parent.submissionId === scope.submissionId
    || verifiedSubmissions?.has(parent.submissionId as string) === true);
}

const rawSpRecordSchema = z.custom<PiTrajectoryRecord>(isPiTrajectoryRecord, "Expected a raw native Pi trajectory envelope")
  .refine((record) => record.ingestSeq === undefined, "Only the outer SP row owns the ingestion cursor");

export const nativeTrajectoryEntrySchema: z.ZodType<NativeTrajectoryEntry> = z.strictObject({
  ingestSeq: z.number().int().positive().safe(),
  record: rawSpRecordSchema,
  // Only the Eval Metrics projection has this field; the public SP page below
  // remains a raw wire and cannot supply or forge local derived facts.
});

const metricFields: Readonly<Record<string, readonly string[]>> = {
  turn: ["type", "phase", "id", "timestamp", "status", "durationMs", "eventId", "scopeKey"],
  model: ["type", "phase", "id", "turnId", "timestamp", "status", "durationMs", "assistantTimestamp",
    "inputTokens", "outputTokens", "totalTokens", "eventId", "scopeKey"],
  tool: ["type", "phase", "id", "turnId", "toolName", "timestamp", "status", "durationMs", "eventId",
    "fromEvent", "fromPiCall", "fromPiResult", "inputLength", "outputLength", "agentId", "submissionId",
    "toolCallKey", "executionId", "scopeKey"],
  assistant: ["type", "id", "timestamp", "taskId", "thinking", "content", "inputTokens", "outputTokens",
    "totalTokens", "scopeKey"],
  request: ["type", "id", "purpose", "timestamp", "scopeKey"],
  hook: ["type", "id", "hook", "taskId", "toolCallId", "timestamp", "durationMs", "outcome", "scopeKey"],
};
const numericMetricFields = new Set(["timestamp", "durationMs", "assistantTimestamp",
  "inputTokens", "outputTokens", "totalTokens", "inputLength", "outputLength"]);
const booleanMetricFields = new Set(["thinking", "content", "fromEvent", "fromPiCall", "fromPiResult"]);
const metricFactSchema = jsonObjectInPlaceSchema.refine((fact) =>
  typeof fact.type === "string" && metricFields[fact.type] !== undefined
  && Object.entries(fact).every(([key, value]) => metricFields[fact.type as string]!.includes(key)
    && (value === null || typeof value === (numericMetricFields.has(key)
      ? "number" : booleanMetricFields.has(key) ? "boolean" : "string"))),
"Expected body-free scalar Metrics facts");

function derivedToolKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(NATIVE_TOOL_CALL_KEY_PREFIX)
    && /^[0-9a-f]{64}$/u.test(value.slice(NATIVE_TOOL_CALL_KEY_PREFIX.length));
}

function scopedToolOperation(value: JsonValue | undefined, source: PiTrajectoryRecordView): boolean {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 4 && parts[0] === source.resource.agentId
      && parts[1] === source.resource.sessionId && parts[2] === source.submissionId
      && derivedToolKey(parts[3]) && JSON.stringify(parts) === value;
  } catch {
    return false;
  }
}

function isCompactNativeSource(value: unknown): value is CompactNativeTrajectoryEntry["record"] {
  const source = object(value);
  if (!source || source.format !== PI_METRIC_RECORD_FORMAT) return false;
  const { format: _format, ...view } = source;
  if (!isPiTrajectoryRecordView(view)) return false;
  const write = view.record;
  return onlyKeys(write.value, write.type === "conversation" ? ["id"] : ["id", "conversationId", "kind"])
    && (view.parent === undefined || onlyKeys(view.parent, ["resource", "submissionId"]));
}

export const compactNativeTrajectoryEntrySchema: z.ZodType<CompactNativeTrajectoryEntry> = z.strictObject({
  ingestSeq: sequence,
  record: z.custom<CompactNativeTrajectoryEntry["record"]>(isCompactNativeSource, "Expected a body-free Metrics source identity"),
  metricProjection: z.strictObject({
    version: z.literal(NATIVE_PROJECTION_VERSION),
    chargeLinkVersion: z.literal(NATIVE_CHARGE_LINK_VERSION),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    supported: z.boolean(),
    complete: z.boolean(),
    facts: z.array(metricFactSchema),
  }).refine((projection) => projection.supported || (!projection.complete && projection.facts.length === 0)),
}).superRefine((entry, context) => {
  if (!isCompactNativeSource(entry.record) || !entry.metricProjection
    || !Array.isArray(entry.metricProjection.facts)) return;
  if (entry.record.submissionId === null && entry.metricProjection.facts.length !== 0) {
    context.addIssue({ code: "custom", path: ["metricProjection", "facts"], message: "Context has no execution facts" });
  }
  for (const [index, fact] of entry.metricProjection.facts.entries()) {
    if (!object(fact)) continue;
    if (fact.type === "tool" && (!scopedToolOperation(fact.id, entry.record)
      || (fact.toolCallKey !== undefined && (!derivedToolKey(fact.toolCallKey)
        || fact.id !== JSON.stringify([
          entry.record.resource.agentId, entry.record.resource.sessionId, entry.record.submissionId, fact.toolCallKey,
        ]) || fact.agentId !== entry.record.resource.agentId || fact.submissionId !== entry.record.submissionId)))) {
      context.addIssue({ code: "custom", path: ["metricProjection", "facts", index],
        message: "Tool facts require scoped derived identities, never raw Call IDs" });
    }
    if (fact.type === "hook" && !scopedToolOperation(fact.toolCallId, entry.record)) {
      context.addIssue({ code: "custom", path: ["metricProjection", "facts", index, "toolCallId"],
        message: "Tool hook identity must be scoped and derived" });
    }
  }
});

export function isCompactNativeTrajectoryEntry(value: unknown): value is CompactNativeTrajectoryEntry {
  return compactNativeTrajectoryEntrySchema.safeParse(value).success;
}

export const resourceNativeTrajectoryEntrySchema: z.ZodType<ResourceNativeTrajectoryEntry> =
  z.union([nativeTrajectoryEntrySchema, compactNativeTrajectoryEntrySchema]);
