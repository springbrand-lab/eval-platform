import {
  PI_TRAJECTORY_RECORD_FORMAT, canonicalJsonBytes, isSafePiTrajectoryRecord, nativeRecordMayBelongToScope, sha256Hex,
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
  let lastSeq = 0;
  for (const entry of snapshot.nativeRecords) {
    if (!Number.isSafeInteger(entry.ingestSeq) || entry.ingestSeq <= lastSeq
      || !isSafePiTrajectoryRecord(entry.record)
      || !nativeRecordMayBelongToScope(entry.record, snapshot.scope)) {
      throw new TypeError(`Cannot compact invalid native trajectory record ${entry.ingestSeq}`);
    }
    lastSeq = entry.ingestSeq;
    const facts = nativeRecordFacts(entry.record);
    const { record } = entry;
    const value = record.record.value;
    const compactWrite: PiTrajectoryRecord["record"] = record.record.type === "conversation"
      ? { type: "conversation", value: { id: value.id } }
      : { type: "entry", value: { id: value.id,
        conversationId: record.record.value.conversationId, kind: record.record.value.kind } };
    nativeRecords.push({
      ingestSeq: entry.ingestSeq,
      record: {
        format: PI_TRAJECTORY_RECORD_FORMAT,
        resource: record.resource,
        submissionId: record.submissionId,
        projection: record.projection,
        ...(record.parent === undefined ? {} : { parent: record.parent }),
        ...(record.origin === undefined ? {} : { origin: record.origin }),
        record: compactWrite,
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
