import type { JsonValue } from "./model.js";
import { z } from "zod";
import { jsonObjectInPlaceSchema } from "./json.js";

/** SP's published Eval Harness wire owns the schema. These are consumer-side structural bounds
 * until the new @springbrand/eval-harness release is available. No event-only records are native. */
export const SP_PI_TRAJECTORY_FORMAT = "sp-pi-trajectory/v1";
export const PI_TRAJECTORY_RECORD_FORMAT = "pi-trajectory/v1";

/** Minimal structural view of the public UA TrajectoryRecord. `record.value` remains
 * opaque native Pi data: Eval never rewrites or reconstructs a Conversation. */
export interface PiTrajectoryRecord {
  readonly format: typeof PI_TRAJECTORY_RECORD_FORMAT;
  readonly resource: { readonly agentId: string; readonly sessionId: string };
  readonly submissionId: string | null;
  readonly projection: { readonly kind: "safe"; readonly policyId: string; readonly policyVersion: number };
  readonly record:
    | { readonly type: "conversation"; readonly value: { readonly id: number } & Readonly<Record<string, JsonValue>> }
    | { readonly type: "entry"; readonly value: {
      readonly id: number; readonly conversationId: number; readonly kind: string;
    } & Readonly<Record<string, JsonValue>> };
  readonly origin?: "execution" | "context";
  readonly parent?: Readonly<Record<string, JsonValue>>;
}

/** Source cursor of a single complete native record; not an event ID or an index into a page. */
export interface NativeTrajectoryEntry {
  readonly ingestSeq: number;
  readonly record: PiTrajectoryRecord;
  /** Eval-only compact metric facts, never a field of SP's public page or raw resource response. */
  readonly metricProjection?: Readonly<Record<string, JsonValue>>;
}

/** The same bounded, frozen page is used for both evidence export and Evaluator final replies. */
export interface SpPiTrajectoryPage {
  readonly format: typeof SP_PI_TRAJECTORY_FORMAT;
  readonly cursor: { readonly throughSeq: number };
  readonly records: readonly NativeTrajectoryEntry[];
  readonly nextAfterSeq: number | null;
}

/** Structural guard only: the future published SP package remains the source of the full schema. */
export function isSafePiTrajectoryRecord(value: unknown): value is PiTrajectoryRecord {
  if (!jsonObjectInPlaceSchema.safeParse(value).success) return false;
  const item = value as Record<string, unknown>;
  const resource = object(item.resource);
  const projection = object(item.projection);
  const write = object(item.record);
  const native = object(write?.value);
  if (item.format !== PI_TRAJECTORY_RECORD_FORMAT
    || !resource || !name(resource.agentId) || !name(resource.sessionId)
    || !onlyKeys(resource, ["agentId", "sessionId"])
    || !projection || projection.kind !== "safe" || !name(projection.policyId)
    || !positive(projection.policyVersion) || !onlyKeys(projection, ["kind", "policyId", "policyVersion"])
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
  // SP's page schema forbids an inner ingestSeq: only the outer stored row owns it.
  return onlyKeys(item, ["format", "resource", "submissionId", "projection", "record", "parent", "origin"])
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

/** SP scopes the resource response to an operation. A temporary Agent can have
 * its own Submission; its public parent still identifies a child of this Chat.
 * Without a verified ancestry chain, only a direct child of the requested
 * Submission is provably in scope. A foreign parent's mere presence is not proof. */
export function nativeRecordMayBelongToScope(
  value: PiTrajectoryRecord, scope: { readonly chatId: string; readonly submissionId: string },
): boolean {
  if (value.resource.sessionId !== scope.chatId || value.submissionId === null) return false;
  if (value.submissionId === scope.submissionId) return true;
  const parent = object(value.parent);
  return parent !== undefined && object(parent.resource)?.sessionId === scope.chatId
    && parent.submissionId === scope.submissionId;
}

export const nativeTrajectoryEntrySchema: z.ZodType<NativeTrajectoryEntry> = z.strictObject({
  ingestSeq: z.number().int().positive().safe(),
  record: z.custom<PiTrajectoryRecord>(isSafePiTrajectoryRecord, "Expected a safe native Pi trajectory record"),
});

export const spPiTrajectoryPageSchema: z.ZodType<SpPiTrajectoryPage> = z.strictObject({
  format: z.literal(SP_PI_TRAJECTORY_FORMAT),
  cursor: z.strictObject({ throughSeq: z.number().int().nonnegative().safe() }),
  records: z.array(nativeTrajectoryEntrySchema),
  nextAfterSeq: z.number().int().nonnegative().safe().nullable(),
});
