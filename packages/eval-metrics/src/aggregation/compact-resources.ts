import {
  PI_METRIC_RECORD_FORMAT, canonicalJsonBytes, nativeTrajectoryEntrySchema, isPiTrajectoryRecordView,
  isCompactNativeTrajectoryEntry, compactNativeTrajectoryEntrySchema, nativeRecordMayBelongToScope, sha256Hex,
  NATIVE_PROJECTION_VERSION, NATIVE_CHARGE_LINK_VERSION,
  type AgentResourceSnapshot, type CompactNativeTrajectoryEntry,
  type NativeTrajectoryInterpretationEntry, type PiTrajectoryRecordView, type ResourceNativeTrajectoryEntry,
} from "@eval-platform/eval-contracts";
import { nativeRecordFacts } from "./native-record-facts.js";

/** The projection is a Metrics storage detail, never an SP trajectory format or a billing source. */
export { NATIVE_PROJECTION_VERSION } from "@eval-platform/eval-contracts";
/** v1 copied restricted IDs; only v2 hashed keys may enter the Action join. */
export { NATIVE_CHARGE_LINK_VERSION } from "@eval-platform/eval-contracts";

/**
 * Body-free facts for a single verified raw record. `sourceSha256` is the digest of
 * original UTF-8 bytes verified by the SP Harness, not a digest of the bounded
 * interpretation it supplied for a large native Pi body. Without one, current
 * object inputs use a canonical-JSON fingerprint.
 */
export async function compactNativeTrajectoryRecord(
  entry: ResourceNativeTrajectoryEntry | NativeTrajectoryInterpretationEntry,
  scope: AgentResourceSnapshot["scope"], sourceSha256?: string,
  verifiedSubmissions?: ReadonlySet<string>,
): Promise<CompactNativeTrajectoryEntry> {
  const interpreted = "interpretation" in entry;
  const source = interpreted ? entry.interpretation.record : entry.record;
  const omittedPaths = interpreted ? entry.interpretation.omittedPaths : [];
  const compact = !interpreted && entry.metricProjection !== undefined;
  const identityPaths = ["/resource", "/submissionId", "/origin", "/parent/resource", "/parent/submissionId",
    "/record/type", "/record/value/id", "/record/value/conversationId", "/record/value/kind"];
  if (!Number.isSafeInteger(entry.ingestSeq) || entry.ingestSeq <= 0
    || (compact ? !isCompactNativeTrajectoryEntry(entry)
      : interpreted ? !isPiTrajectoryRecordView(source) : !nativeTrajectoryEntrySchema.safeParse(entry).success)
    || !nativeRecordMayBelongToScope(source, scope, verifiedSubmissions)
    || (interpreted && (sourceSha256 === undefined || !Array.isArray(omittedPaths)
      || omittedPaths.some((path) => typeof path !== "string" || !/^(?:\/(?:[^~]|~[01])*)*$/u.test(path))))
    || (interpreted && omittedPaths.some((path) => identityPaths.some((identity) =>
      identity === path || identity.startsWith(`${path}/`) || path.startsWith(`${identity}/`))))
    || (sourceSha256 !== undefined && !/^[0-9a-f]{64}$/u.test(sourceSha256))) {
    throw new TypeError(`Cannot compact invalid native trajectory record ${entry.ingestSeq}`);
  }
  if (isCompactNativeTrajectoryEntry(entry)) {
    if (sourceSha256 !== undefined && entry.metricProjection.fingerprint !== sourceSha256) {
      throw new TypeError(`Cannot change compact native trajectory fingerprint ${entry.ingestSeq}`);
    }
    return entry;
  }
  const facts = nativeRecordFacts(source, omittedPaths);
  const value = source.record.value;
  const compactWrite: PiTrajectoryRecordView["record"] = source.record.type === "conversation"
    ? { type: "conversation", value: { id: value.id } }
    : { type: "entry", value: { id: value.id,
      conversationId: source.record.value.conversationId, kind: source.record.value.kind } };
  const result: CompactNativeTrajectoryEntry = {
    ingestSeq: entry.ingestSeq,
    record: {
      format: PI_METRIC_RECORD_FORMAT,
      resource: source.resource,
      // Parent scope proves a descendant belongs to this Chat. Optional parent
      // toolCallId/requestId/runId can hold opaque provider IDs or credentials;
      // they are not needed by Metrics or the Action join.
      ...(source.parent === undefined ? {} : { parent: {
        resource: source.parent.resource!, submissionId: source.parent.submissionId!,
      } }),
      ...(source.submissionId === null
        ? { submissionId: null, origin: "context" }
        : { submissionId: source.submissionId, ...(source.origin === undefined ? {} : { origin: source.origin }) }),
      record: compactWrite,
    },
    metricProjection: {
      version: NATIVE_PROJECTION_VERSION,
      chargeLinkVersion: NATIVE_CHARGE_LINK_VERSION,
      fingerprint: sourceSha256 ?? await sha256Hex(canonicalJsonBytes(source)),
      supported: facts !== undefined,
      complete: facts !== undefined && omittedPaths.length === 0,
      facts: [...facts ?? []],
    },
  };
  if (!compactNativeTrajectoryEntrySchema.safeParse(result).success) {
    throw new TypeError(`Cannot persist noncompact native trajectory facts ${entry.ingestSeq}`);
  }
  return result;
}

/** Current raw inputs and current compact facts share the same Metrics interpreter.
 * Billing/usage events remain independent and authoritative, never derived from Pi. */
export async function compactResourceSnapshot(snapshot: AgentResourceSnapshot):
Promise<Omit<AgentResourceSnapshot, "nativeRecords"> & { readonly nativeRecords: readonly CompactNativeTrajectoryEntry[] }> {
  if (!Array.isArray(snapshot.nativeRecords)) {
    throw new TypeError("Cannot compact an event-only resource snapshot as native Pi evidence");
  }
  const nativeRecords: CompactNativeTrajectoryEntry[] = [];
  let lastSeq = 0;
  const verifiedSubmissions = new Set([snapshot.scope.submissionId]);
  for (const entry of snapshot.nativeRecords) {
    if (entry.ingestSeq <= lastSeq) throw new TypeError(`Cannot compact invalid native trajectory record ${entry.ingestSeq}`);
    lastSeq = entry.ingestSeq;
    nativeRecords.push(await compactNativeTrajectoryRecord(entry, snapshot.scope, undefined, verifiedSubmissions));
    if (entry.record.submissionId !== null) verifiedSubmissions.add(entry.record.submissionId);
  }
  return { ...snapshot, nativeRecords };
}
