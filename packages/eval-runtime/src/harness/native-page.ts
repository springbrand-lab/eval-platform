import { jsonObjectInPlaceSchema } from "@eval-platform/eval-contracts";
import { PI_TRAJECTORY_FORMAT, type TrajectoryRecord } from "@springbrand/eval-harness";
import { z } from "zod";
import { distinctNativeRecords, parseSafeTrajectoryRecord } from "./native-execution.js";

/** The existing public SP Chat history page; not an execution membership or an evidence cursor. */
export interface NativeTrajectoryPage {
  readonly format: typeof PI_TRAJECTORY_FORMAT;
  readonly events: readonly { readonly ingestSeq: number; readonly event: TrajectoryRecord }[];
  readonly beforeSeq: number | null;
  readonly hasOlder: boolean;
}

export function readNativeTrajectoryPage(value: unknown, query: {
  readonly beforeSeq?: number; readonly limit?: number;
} = {}): NativeTrajectoryPage {
  jsonObjectInPlaceSchema.parse(value);
  const page = z.object({
    format: z.literal(PI_TRAJECTORY_FORMAT),
    events: z.array(z.object({
      ingestSeq: z.number().int().positive().safe(), event: z.unknown(),
    })).max(query.limit ?? 100),
    beforeSeq: z.number().int().positive().safe().nullable(), hasOlder: z.boolean(),
  }).parse(value);
  let last = 0;
  const events = page.events.map((item) => {
    if (item.ingestSeq <= last || query.beforeSeq !== undefined && item.ingestSeq >= query.beforeSeq) {
      throw new Error("Native trajectory receiving-store order is contradictory");
    }
    last = item.ingestSeq;
    const event = parseSafeTrajectoryRecord(item.event);
    if (event.ingestSeq !== undefined) throw new Error("A source trajectory record cannot own a receiving cursor");
    return { ingestSeq: item.ingestSeq, event };
  });
  distinctNativeRecords(events.map((item) => item.event));
  if (page.hasOlder && (!events.length || page.beforeSeq !== events[0]?.ingestSeq)) {
    throw new Error("Native trajectory history cursor did not advance");
  }
  return { ...page, events };
}
