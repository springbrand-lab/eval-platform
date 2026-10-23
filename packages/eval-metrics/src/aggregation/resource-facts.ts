import type { AgentResourceScope, AgentResourceSnapshot, JsonValue } from "@eval-platform/eval-contracts";
import { equalJson } from "@eval-platform/eval-contracts";
import { HISTORICAL_SP_TRAJECTORY_FORMAT, PI_TRAJECTORY_FORMAT, TrajectoryFormatError, storedTrajectoryFormat } from "@eval-platform/eval-runtime/harness";
import { record, text, type JsonRecord } from "../json.js";
import { TELEMETRY_PROJECTION_VERSION, nativeMetricSchema, nativeSnapshotProjectionSchema, telemetryFingerprint, type NativeMetricRecord } from "./native-facts.js";
import type { MetricNumber, ResourceDiagnostic } from "./model.js";
import { coverage } from "./statistics.js";

export type Stream = ResourceDiagnostic["stream"];

export interface FactEntry {
  readonly fact: JsonRecord;
  readonly metricProjection?: JsonRecord;
  readonly native?: NativeMetricRecord;
  readonly fingerprint?: string;
  readonly ownerUserId: string;
  /** True when the Attempt that supplied this fact can still emit telemetry. */
  readonly canEmitTelemetry: boolean;
  readonly scope: AgentResourceScope;
}

/** One resource stream after source-identity deduplication. */
export interface FactStream {
  readonly entries: readonly FactEntry[];
  readonly complete: boolean;
  readonly duplicates: number;
}

export interface OwnedSnapshot {
  readonly ownerUserId: string;
  readonly canEmitTelemetry: boolean;
  readonly snapshot: AgentResourceSnapshot;
}

export function identity(...values: readonly (string | null)[]): string {
  return JSON.stringify(values);
}

/** Collects distinct diagnostics in first-report order and validates numeric facts against them. */
export class ResourceDiagnostics {
  readonly #items: ResourceDiagnostic[] = [];
  readonly #keys = new Set<string>();

  report(kind: ResourceDiagnostic["kind"], stream: Stream, entry: FactEntry, message: string): void {
    const eventId = entry.native?.sourceIdentity ?? text(entry.fact.eventId);
    const diagnostic = { kind, stream, scope: { ...entry.scope }, message, ...(eventId === undefined ? {} : { eventId }) };
    const key = JSON.stringify(diagnostic);
    if (this.#keys.has(key)) return;
    this.#keys.add(key);
    this.#items.push(diagnostic);
  }

  /** A present fact value as a non-negative safe number, or null with a diagnostic when it is invalid. */
  number(entry: FactEntry, stream: Stream, value: JsonValue | undefined, field: string, integer: boolean): number | null {
    if (value === undefined || value === null) return null;
    if (
      typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
      && (!integer || Number.isSafeInteger(value))
    ) return value;
    this.report("invalid-value", stream, entry, `Invalid ${field}`);
    return null;
  }

  /** Sums the readable values; `complete` only proves zero or full coverage when every value is present. */
  sum(
    entries: readonly FactEntry[],
    complete: boolean,
    stream: Stream,
    field: string,
    integer: boolean,
    read: (entry: FactEntry) => number | null,
  ): MetricNumber {
    const [first] = entries;
    if (first === undefined) return { value: complete ? 0 : null, coverage: coverage(complete, false) };
    const values = entries.map(read);
    const available = values.filter((value): value is number => value !== null);
    if (available.length === 0) return { value: null, coverage: "unavailable" };
    const total = available.reduce((previous, value) => previous + value, 0);
    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(total))) {
      this.report("invalid-value", stream, first, `${field} aggregate exceeds the safe number range`);
      return { value: null, coverage: "unavailable" };
    }
    return { value: total, coverage: coverage(complete && available.length === values.length, true) };
  }

  list(): readonly ResourceDiagnostic[] {
    return [...this.#items];
  }
}

function sourceIdentity(stream: Stream, ownerUserId: string, fact: JsonRecord): string | undefined {
  const eventId = text(fact.eventId);
  if (stream === "usageEvents") return eventId ? identity(ownerUserId, eventId) : undefined;
  if (stream === "telemetryEvents") {
    const sessionId = text(record(fact.resource)?.sessionId);
    return eventId && sessionId ? identity(HISTORICAL_SP_TRAJECTORY_FORMAT, sessionId, eventId) : undefined;
  }
  const executionId = text(fact.executionId);
  if (executionId) return identity("action", executionId);
  const accountId = text(fact.accountId);
  return accountId && eventId ? identity("model", accountId, eventId) : undefined;
}

/** Reads one stream across snapshots, dropping repeated source identities and both sides of a contradiction. */
export function readStream(
  snapshots: readonly OwnedSnapshot[],
  stream: Stream,
  collectionsComplete: boolean,
  diagnostics: ResourceDiagnostics,
): FactStream {
  let complete = collectionsComplete;
  let duplicates = 0;
  const byIdentity = new Map<string, FactEntry | null>();
  for (const { ownerUserId, canEmitTelemetry, snapshot } of snapshots) {
    const format = storedTrajectoryFormat(snapshot.trajectoryFormat);
    if (stream === "usageEvents" && format === PI_TRAJECTORY_FORMAT) continue;
    if (!snapshot.finalized || snapshot.coverage[stream] !== "complete") complete = false;
    if (format === PI_TRAJECTORY_FORMAT) {
      const metadata = nativeSnapshotProjectionSchema.parse((snapshot as unknown as Record<string, unknown>).metricProjection);
      if (!metadata.complete) complete = false;
      if (stream === "telemetryEvents") {
        for (const message of metadata.diagnostics) diagnostics.report("unsupported-record", stream,
          { fact: {}, ownerUserId, canEmitTelemetry, scope: snapshot.scope }, message);
      }
    }
    for (const rawFact of snapshot[stream]) {
      let fact = stream === "telemetryEvents" ? record(rawFact.event) ?? rawFact : rawFact;
      const projection = stream === "telemetryEvents" ? record(rawFact.metricProjection) : undefined;
      let native: NativeMetricRecord | undefined;
      let fingerprint: string | undefined;
      let metricProjection: JsonRecord | undefined;
      if (stream === "telemetryEvents") {
        if (format === PI_TRAJECTORY_FORMAT) {
          if (!projection || projection.version !== TELEMETRY_PROJECTION_VERSION || projection.sourceFormat !== PI_TRAJECTORY_FORMAT) {
            throw new Error(`Unsupported native telemetry projection version: ${String(projection?.version)}`);
          }
          native = nativeMetricSchema.parse(projection.native);
          fingerprint = text(projection.fingerprint);
          if (!fingerprint) throw new Error("Native telemetry projection has no source fingerprint");
          fact = { sourceIdentity: native.sourceIdentity };
        } else {
          if (fact.format !== undefined && fact.format !== HISTORICAL_SP_TRAJECTORY_FORMAT) throw new TrajectoryFormatError(fact.format);
          if (projection) {
            if (![1, 2, 3].includes(Number(projection.version)) || typeof projection.fingerprint !== "string") {
              throw new Error(`Unsupported historical telemetry projection version: ${String(projection.version)}`);
            }
            metricProjection = projection;
          }
          fingerprint = metricProjection ? text(metricProjection.fingerprint) : telemetryFingerprint(fact);
        }
      }
      const entry: FactEntry = {
        fact, ownerUserId, canEmitTelemetry, scope: snapshot.scope,
        ...(metricProjection ? { metricProjection } : {}),
        ...(native ? { native } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      };
      const key = native?.sourceIdentity ?? sourceIdentity(stream, ownerUserId, fact);
      if (key === undefined) {
        complete = false;
        diagnostics.report("missing-identity", stream, entry, `Cannot identify ${stream} record`);
        continue;
      }
      const existing = byIdentity.get(key);
      if (existing === undefined) {
        byIdentity.set(key, entry);
        continue;
      }
      duplicates += 1;
      if (existing && existing.fingerprint && fingerprint && existing.fingerprint === fingerprint) {
        const existingVersion = typeof existing.metricProjection?.version === "number" ? existing.metricProjection.version : 0;
        const version = typeof metricProjection?.version === "number" ? metricProjection.version : 0;
        if (existing.metricProjection && metricProjection && version === existingVersion && !equalJson(existing.metricProjection, metricProjection)) {
          complete = false;
          diagnostics.report("conflicting-identity", stream, entry, "The same source identity has contradictory metric projections");
          byIdentity.set(key, null);
        } else {
          const selected = version > existingVersion ? entry : existing;
          byIdentity.set(key, {
            ...selected, canEmitTelemetry: existing.canEmitTelemetry === true || entry.canEmitTelemetry === true,
            ...(selected.native ? { native: { ...selected.native, selected: existing.native?.selected === true || native?.selected === true } } : {}),
          });
        }
        continue;
      }
      if (existing && !(existing.fingerprint && fingerprint
        ? existing.fingerprint === fingerprint : equalJson(existing.fact, fact))) {
        complete = false;
        diagnostics.report("conflicting-identity", stream, entry, "The same source identity has contradictory facts");
        byIdentity.set(key, null);
      }
    }
  }
  return { entries: [...byIdentity.values()].filter((entry) => entry !== null), complete, duplicates };
}
