import {
  PI_TRAJECTORY_RECORD_FORMAT, canonicalJsonBytes, sha256Hex,
  type AgentResourceSnapshot, type NativeTrajectoryEntry, type PiTrajectoryRecord,
} from "@eval-platform/eval-contracts";
import { nativeRecordFacts } from "./native-record-facts.js";

/** The projection is a Metrics storage detail, never an SP trajectory format or a billing source. */
export const NATIVE_PROJECTION_VERSION = 1;

/** Compact safe, versioned metric facts while preserving the raw Attempt snapshot separately.
 * Hash one complete native record at a time: no full prompt or generation input is retained in
 * the Metrics read model. Billing/usage events remain unchanged and authoritative. */
export async function compactResourceSnapshot(snapshot: AgentResourceSnapshot): Promise<AgentResourceSnapshot> {
  if (!Array.isArray(snapshot.nativeRecords)) {
    throw new TypeError("Cannot compact an event-only resource snapshot as native Pi evidence");
  }
  const nativeRecords: NativeTrajectoryEntry[] = [];
  for (const entry of snapshot.nativeRecords) {
    const facts = nativeRecordFacts(entry.record);
    if (!Number.isSafeInteger(entry.ingestSeq) || entry.ingestSeq <= 0
      || entry.record.format !== PI_TRAJECTORY_RECORD_FORMAT || entry.record.projection?.kind !== "safe"
      || (entry.record.chatId !== undefined && entry.record.chatId !== snapshot.scope.chatId)
      || (entry.record.submissionId !== undefined && entry.record.submissionId !== snapshot.scope.submissionId)) {
      throw new TypeError(`Cannot compact invalid native trajectory record ${entry.ingestSeq}`);
    }
    nativeRecords.push({
      ingestSeq: entry.ingestSeq,
      record: {
        format: PI_TRAJECTORY_RECORD_FORMAT,
        ...(typeof entry.record.kind !== "string" ? {} : { kind: entry.record.kind }),
        projection: { kind: "safe" },
        ...(entry.record.chatId === undefined ? {} : { chatId: entry.record.chatId }),
        ...(entry.record.submissionId === undefined ? {} : { submissionId: entry.record.submissionId }),
      } satisfies PiTrajectoryRecord,
      metricProjection: {
        version: NATIVE_PROJECTION_VERSION,
        fingerprint: await sha256Hex(canonicalJsonBytes(entry.record)),
        supported: facts !== undefined,
        facts: [...facts ?? []],
      },
    });
  }
  return { ...snapshot, nativeRecords };
}
