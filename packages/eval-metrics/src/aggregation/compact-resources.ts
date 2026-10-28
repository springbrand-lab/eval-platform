import {
  PI_TRAJECTORY_RECORD_FORMAT, canonicalJsonBytes, isSafePiTrajectoryRecord, nativeRecordMayBelongToScope, sha256Hex,
  type AgentResourceSnapshot, type JsonValue, type NativeTrajectoryEntry, type PiTrajectoryRecord,
} from "@eval-platform/eval-contracts";
import { nativeRecordFacts } from "./native-record-facts.js";

/** The projection is a Metrics storage detail, never an SP trajectory format or a billing source. */
export const NATIVE_PROJECTION_VERSION = 1;

/**
 * Body-free facts for a single verified SAFE record. `sourceSha256` is the digest of
 * original UTF-8 bytes verified by the SP Harness, not a digest of the bounded
 * interpretation it supplied for a large native Pi body. Without one, historical
 * object snapshots keep their existing canonical-JSON fingerprint.
 */
export async function compactNativeTrajectoryRecord(
  entry: NativeTrajectoryEntry, scope: AgentResourceSnapshot["scope"], sourceSha256?: string,
): Promise<NativeTrajectoryEntry> {
  if (!Number.isSafeInteger(entry.ingestSeq) || entry.ingestSeq <= 0
    || !isSafePiTrajectoryRecord(entry.record)
    || !nativeRecordMayBelongToScope(entry.record, scope)
    || (sourceSha256 !== undefined && !/^[0-9a-f]{64}$/u.test(sourceSha256))) {
    throw new TypeError(`Cannot compact invalid native trajectory record ${entry.ingestSeq}`);
  }
  if (entry.metricProjection !== undefined) return entry;
  const facts = nativeRecordFacts(entry.record as unknown as Readonly<Record<string, JsonValue>>);
  const { record } = entry;
  const value = record.record.value;
  const compactWrite: PiTrajectoryRecord["record"] = record.record.type === "conversation"
    ? { type: "conversation", value: { id: value.id } }
    : { type: "entry", value: { id: value.id,
      conversationId: record.record.value.conversationId, kind: record.record.value.kind } };
  return {
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
      fingerprint: sourceSha256 ?? await sha256Hex(canonicalJsonBytes(entry.record)),
      supported: facts !== undefined,
      facts: [...facts ?? []],
    },
  };
}

/** Historical raw snapshots and current compact ones share the same Metrics interpreter.
 * Billing/usage events remain independent and authoritative, never derived from Pi. */
export async function compactResourceSnapshot(snapshot: AgentResourceSnapshot): Promise<AgentResourceSnapshot> {
  if (!Array.isArray(snapshot.nativeRecords)) {
    throw new TypeError("Cannot compact an event-only resource snapshot as native Pi evidence");
  }
  const nativeRecords: NativeTrajectoryEntry[] = [];
  let lastSeq = 0;
  for (const entry of snapshot.nativeRecords) {
    if (entry.ingestSeq <= lastSeq) throw new TypeError(`Cannot compact invalid native trajectory record ${entry.ingestSeq}`);
    lastSeq = entry.ingestSeq;
    nativeRecords.push(await compactNativeTrajectoryRecord(entry, snapshot.scope));
  }
  return { ...snapshot, nativeRecords };
}
