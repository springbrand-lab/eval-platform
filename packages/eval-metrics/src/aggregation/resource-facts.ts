import type { AgentResourceScope, AgentResourceSnapshot, JsonValue, NativeTrajectoryEntry } from "@eval-platform/eval-contracts";
import { equalJson } from "@eval-platform/eval-contracts";
import { record, text, type JsonRecord } from "../json.js";
import { NATIVE_PROJECTION_VERSION } from "./compact-resources.js";
import type { MetricNumber, ResourceDiagnostic } from "./model.js";
import { coverage } from "./statistics.js";

export type Stream = ResourceDiagnostic["stream"];

export interface FactEntry {
  readonly fact: JsonRecord;
  readonly metricProjection?: JsonRecord;
  readonly ingestSeq?: number;
  readonly ownerUserId: string;
  /** True when the Attempt that supplied this fact can still emit native records. */
  readonly canEmitNativeRecords: boolean;
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
  readonly canEmitNativeRecords: boolean;
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
    const eventId = text(entry.fact.eventId);
    const diagnostic = { kind, stream, scope: { ...entry.scope }, message,
      ...(eventId === undefined ? {} : { eventId }),
      ...(entry.ingestSeq === undefined ? {} : { ingestSeq: entry.ingestSeq }) };
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

function sourceIdentity(stream: Stream, ownerUserId: string, fact: JsonRecord, scope: AgentResourceScope, seq?: number): string | undefined {
  if (stream === "nativeRecords") {
    return Number.isSafeInteger(seq) && seq! > 0 && text(scope.chatId)
      ? identity(ownerUserId, scope.chatId, String(seq)) : undefined;
  }
  const eventId = text(fact.eventId);
  if (stream === "usageEvents") return eventId ? identity(ownerUserId, eventId) : undefined;
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
  for (const { ownerUserId, canEmitNativeRecords, snapshot } of snapshots) {
    if (!snapshot.finalized || snapshot.coverage?.[stream] !== "complete") complete = false;
    const facts: readonly (JsonRecord | NativeTrajectoryEntry)[] | undefined = snapshot[stream];
    if (!Array.isArray(facts)) {
      complete = false;
      diagnostics.report("unsupported-record", stream, {
        fact: {}, ownerUserId, canEmitNativeRecords, scope: snapshot.scope,
      }, `Snapshot has no ${stream} stream; an event-only snapshot is not native evidence`);
      continue;
    }
    for (const raw of facts) {
      const native = stream === "nativeRecords" ? raw as NativeTrajectoryEntry : undefined;
      const fact = native ? record(native.record) ?? {} : raw as JsonRecord;
      const projection = native ? record(native.metricProjection) : undefined;
      const metricProjection = projection?.version === NATIVE_PROJECTION_VERSION
        && typeof projection.fingerprint === "string" && typeof projection.supported === "boolean"
        && Array.isArray(projection.facts) && projection.facts.every((item) => record(item) !== undefined)
        ? projection : undefined;
      const entry: FactEntry = {
        fact, ownerUserId, canEmitNativeRecords, scope: snapshot.scope,
        ...(native === undefined ? {} : { ingestSeq: native.ingestSeq }),
        ...(metricProjection ? { metricProjection } : {}),
      };
      if (native && ((fact.chatId !== undefined && fact.chatId !== snapshot.scope.chatId)
        || (fact.submissionId !== undefined && fact.submissionId !== snapshot.scope.submissionId))) {
        complete = false;
        diagnostics.report("conflicting-identity", stream, entry, "Native record is outside its resource snapshot operation");
        continue;
      }
      if (native?.metricProjection !== undefined && metricProjection === undefined) {
        complete = false;
        diagnostics.report("unsupported-record", stream, entry, "Unsupported compact native metric projection");
        continue;
      }
      const key = sourceIdentity(stream, ownerUserId, fact, snapshot.scope, native?.ingestSeq);
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
      if (existing && existing.metricProjection && metricProjection
        && existing.metricProjection.fingerprint === metricProjection.fingerprint) {
        const existingVersion = typeof existing.metricProjection.version === "number" ? existing.metricProjection.version : 0;
        const version = typeof metricProjection.version === "number" ? metricProjection.version : 0;
        if (version > existingVersion) byIdentity.set(key, entry);
        else if (version === existingVersion && !equalJson(existing.metricProjection, metricProjection)) {
          complete = false;
          diagnostics.report("conflicting-identity", stream, entry, "The same source identity has contradictory metric projections");
          byIdentity.set(key, null);
        }
        continue;
      }
      if (existing && (existing.metricProjection && metricProjection
        ? existing.metricProjection.fingerprint !== metricProjection.fingerprint
        : !equalJson(existing.fact, fact))) {
        complete = false;
        diagnostics.report("conflicting-identity", stream, entry, "The same source identity has contradictory facts");
        byIdentity.set(key, null);
      }
    }
  }
  return { entries: [...byIdentity.values()].filter((entry) => entry !== null), complete, duplicates };
}
