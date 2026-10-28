import type { JsonValue } from "./model.js";
import { z } from "zod";
import { jsonObjectInPlaceSchema } from "./json.js";

/** SP's published Eval Harness wire owns the schema. These are consumer-side structural bounds
 * until the new @springbrand/eval-harness release is available. No event-only records are native. */
export const SP_PI_TRAJECTORY_FORMAT = "sp-pi-trajectory/v1";
export const PI_TRAJECTORY_RECORD_FORMAT = "pi-trajectory/v1";

export interface PiTrajectoryRecord {
  readonly format: typeof PI_TRAJECTORY_RECORD_FORMAT;
  readonly projection: { readonly kind: "safe"; readonly [key: string]: JsonValue };
  /** SP's future public TrajectoryRecord owns all additional fields. An unrecognized
   * record must still be exported unchanged; Metrics diagnoses it, never fakes zeros. */
  readonly [key: string]: JsonValue;
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
  if (!item.projection || typeof item.projection !== "object" || Array.isArray(item.projection)) return false;
  return item.format === PI_TRAJECTORY_RECORD_FORMAT
    && (item.projection as { kind?: unknown }).kind === "safe";
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
