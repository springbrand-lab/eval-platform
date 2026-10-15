import type { AgentResourceScope, AgentResourceSnapshot, JsonValue } from "@eval-platform/eval-contracts";
import { equalJson } from "@eval-platform/eval-contracts";
import type { MetricNumber, ResourceDiagnostic } from "./model.js";

export type Stream = ResourceDiagnostic["stream"];
export type JsonRecord = Readonly<Record<string, JsonValue>>;

export interface FactEntry {
  readonly fact: JsonRecord;
  readonly ownerUserId: string;
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
  readonly snapshot: AgentResourceSnapshot;
}

export function record(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

export function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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
    if (first === undefined) return { value: complete ? 0 : null, coverage: complete ? "complete" : "unavailable" };
    const values = entries.map(read);
    const available = values.filter((value): value is number => value !== null);
    if (available.length === 0) return { value: null, coverage: "unavailable" };
    const total = available.reduce((previous, value) => previous + value, 0);
    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(total))) {
      this.report("invalid-value", stream, first, `${field} aggregate exceeds the safe number range`);
      return { value: null, coverage: "unavailable" };
    }
    return { value: total, coverage: complete && available.length === values.length ? "complete" : "partial" };
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
    return eventId && sessionId ? identity(sessionId, eventId) : undefined;
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
  for (const { ownerUserId, snapshot } of snapshots) {
    if (!snapshot.finalized || snapshot.coverage[stream] !== "complete") complete = false;
    for (const rawFact of snapshot[stream]) {
      const fact = stream === "telemetryEvents" ? record(rawFact.event) ?? rawFact : rawFact;
      const entry = { fact, ownerUserId, scope: snapshot.scope };
      const key = sourceIdentity(stream, ownerUserId, fact);
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
      if (existing && !equalJson(existing.fact, fact)) {
        complete = false;
        diagnostics.report("conflicting-identity", stream, entry, "The same source identity has contradictory facts");
        byIdentity.set(key, null);
      }
    }
  }
  return { entries: [...byIdentity.values()].filter((entry) => entry !== null), complete, duplicates };
}
