import { jsonObjectInPlaceSchema, type AgentResourceFact, type AgentResourceSnapshot } from "@eval-platform/eval-contracts";
import {
  PI_TRAJECTORY_FORMAT, nativeExecutionKey, nativeExecutionMembers, openNativeExecution, parseSafeTrajectoryRecord,
  storedTrajectoryFormat, trajectoryRecordIdentity, isEvalTrajectoryDelivered,
  nativeResourceReadinessSchema, validateNativeResourceScope,
} from "@eval-platform/eval-runtime/harness";
import { record } from "../json.js";
import { TELEMETRY_PROJECTION_VERSION, nativeMetricSchema, nativeSnapshotProjectionSchema, projectNativeRecord, telemetryFingerprint } from "./native-facts.js";

export { TELEMETRY_PROJECTION_VERSION } from "./native-facts.js";
export { telemetryBodyLength, telemetryOutputLength, telemetryContentFlags } from "./telemetry-content.js";

/** Derive current native metrics from source, or validate the current cache; never migrate or write back. */
export async function compactResourceSnapshot(snapshot: AgentResourceSnapshot): Promise<AgentResourceSnapshot> {
  const stored = record((snapshot as AgentResourceSnapshot & { readonly metricProjection?: AgentResourceFact }).metricProjection);
  if (snapshot.trajectoryFormat !== PI_TRAJECTORY_FORMAT && (
    stored?.sourceFormat === PI_TRAJECTORY_FORMAT ||
    snapshot.telemetryEvents.some((raw) => (record(raw.event) ?? raw).format === PI_TRAJECTORY_FORMAT)
  )) throw new Error("Native resources require an explicit pi-trajectory/v1 format");
  if (storedTrajectoryFormat(snapshot.trajectoryFormat) !== PI_TRAJECTORY_FORMAT) return snapshot;
  if (stored && stored.version !== TELEMETRY_PROJECTION_VERSION) {
    throw new Error(`Unsupported native telemetry projection version: ${String(stored.version)}`);
  }
  const readiness = nativeResourceReadinessSchema.parse(snapshot.readiness);
  validateNativeResourceScope({ ...snapshot, readiness }, true);
  const delivery = readiness.trajectory;
  const members = delivery.resource !== null && delivery.submissionId !== null ? nativeExecutionMembers(delivery) : [];
  const scopeFingerprint = telemetryFingerprint(jsonObjectInPlaceSchema.parse({ scope: snapshot.scope, trajectory: delivery }));
  if (stored) {
    const metadata = nativeSnapshotProjectionSchema.parse(stored);
    if (metadata.scopeFingerprint !== scopeFingerprint) throw new Error("Native metric cache belongs to another execution scope");
    const memberKeys = new Set(members.map(nativeExecutionKey));
    for (const raw of snapshot.telemetryEvents) {
      if (raw.format !== undefined) throw new Error("A native metric cache cannot contain raw native records");
      const projection = record(raw.metricProjection);
      if (projection?.version !== TELEMETRY_PROJECTION_VERSION || projection.sourceFormat !== PI_TRAJECTORY_FORMAT) {
        throw new Error(`Unsupported native telemetry projection version: ${String(projection?.version)}`);
      }
      if (typeof projection.fingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(projection.fingerprint)) {
        throw new Error("Native metric cache has no valid source fingerprint");
      }
      const native = nativeMetricSchema.parse(projection.native);
      if (native.sourceIdentity !== JSON.stringify([native.resource.agentId, native.resource.sessionId, native.recordType, native.id])) {
        throw new Error("Native metric cache has inconsistent source identity");
      }
      if (native.selected && (native.submissionId === null ||
        !memberKeys.has(nativeExecutionKey({ resource: native.resource, submissionId: native.submissionId })))) {
        throw new Error("Native metric cache selects records outside its execution scope");
      }
    }
    return snapshot;
  }
  const source = snapshot.telemetryEvents.map((raw) => {
    if (raw.metricProjection !== undefined) {
      throw new Error("Unsupported native telemetry projection version or missing snapshot metadata");
    }
    return parseSafeTrajectoryRecord(record(raw.event) ?? raw);
  });
  let selected: ReadonlySet<string> = new Set();
  let complete = isEvalTrajectoryDelivered(delivery);
  let diagnostics: readonly string[] = complete ? [] : ["Native trajectory delivery or required membership is incomplete"];
  if (members.length === 0) diagnostics = [...diagnostics, "Native trajectory root execution identity is unavailable"];
  try {
    if (members.length > 0) {
      const view = await openNativeExecution(source, members);
      try {
        selected = view.selected;
        complete &&= view.complete;
        diagnostics = [...diagnostics, ...view.diagnostics];
      } finally {
        await view.close();
      }
    }
  } catch (error) {
    complete = false;
    diagnostics = [...diagnostics, error instanceof Error ? error.message : String(error)];
  }
  const telemetryEvents: AgentResourceFact[] = [];
  for (const event of source) {
    telemetryEvents.push(jsonObjectInPlaceSchema.parse({ metricProjection: {
      version: TELEMETRY_PROJECTION_VERSION, sourceFormat: PI_TRAJECTORY_FORMAT,
      fingerprint: telemetryFingerprint(jsonObjectInPlaceSchema.parse(event)),
      native: projectNativeRecord(event, selected.has(trajectoryRecordIdentity(event))),
    } }));
  }
  return { ...snapshot, telemetryEvents, metricProjection: {
    version: TELEMETRY_PROJECTION_VERSION, sourceFormat: PI_TRAJECTORY_FORMAT, scopeFingerprint, complete, diagnostics,
  } } as AgentResourceSnapshot;
}
