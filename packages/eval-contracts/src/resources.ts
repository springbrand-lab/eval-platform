import type { JsonValue } from "./model.js";
import type { NativeTrajectoryEntry } from "./native-trajectory.js";

export interface AgentResourceScope {
  readonly chatId: string;
  readonly idempotencyKey: string;
  /** Assigned by SP when the operation is submitted; absent before its receipt is known. */
  readonly submissionId?: string;
}

export interface SubmittedAgentResourceScope extends AgentResourceScope {
  readonly submissionId: string;
}

export type AgentResourceFact = Readonly<Record<string, JsonValue>>;

export type AgentResourceCompleteness = "complete" | "partial" | "unavailable";

export interface AgentResourceCoverage {
  readonly usageEvents: AgentResourceCompleteness;
  readonly nativeRecords: AgentResourceCompleteness;
  readonly billingSettlements: AgentResourceCompleteness;
}

export interface AgentResourceSnapshot {
  readonly scope: SubmittedAgentResourceScope;
  readonly observedAt: string;
  readonly finalized: boolean;
  readonly coverage: AgentResourceCoverage;
  readonly usageEvents: readonly AgentResourceFact[];
  /** Raw source records historically; new byte-stream reads retain only checked,
   * body-free Pi identities and compact metric facts. No public transfer references. */
  readonly nativeRecords: readonly NativeTrajectoryEntry[];
  readonly billingSettlements: readonly AgentResourceFact[];
  /** SP's own explanation of why `finalized` is false; diagnostic only, never a second completeness signal. */
  readonly readiness?: AgentResourceReadiness;
}

export interface AgentResourceReadiness {
  readonly receiptTerminal: boolean;
  readonly stateUnreadable: boolean;
  readonly pendingTelemetryEvents: number;
  readonly pendingRuntimeEvents: number;
  readonly actionCharges: {
    readonly complete: boolean;
    readonly unsettledExecutions: number;
    readonly missingExecutionIds: number;
  };
}

/** Whether SP has finalized a snapshot, without its events; Runtime waits on this before downloading. */
export interface AgentResourceReadinessReport {
  readonly scope: SubmittedAgentResourceScope;
  readonly observedAt: string;
  readonly finalized: boolean;
  readonly readiness: AgentResourceReadiness;
}

export interface AgentResourceCounts {
  readonly usageEvents: number;
  readonly nativeRecords: number;
  readonly billingSettlements: number;
}

/** What a stage record keeps of a stored snapshot; compact facts live only in the resource store. */
export type AgentResourceSnapshotSummary = Omit<AgentResourceSnapshot, "usageEvents" | "nativeRecords" | "billingSettlements"> & {
  readonly counts: AgentResourceCounts;
};

export function summarizeResourceSnapshot(snapshot: AgentResourceSnapshot): AgentResourceSnapshotSummary {
  const { usageEvents, nativeRecords, billingSettlements, ...summary } = snapshot;
  return {
    ...summary,
    counts: { usageEvents: usageEvents.length, nativeRecords: nativeRecords.length, billingSettlements: billingSettlements.length },
  };
}

/** A bounded, already-verified part of a newly collected resource snapshot. This is an
 * application-to-Store transfer, not another SP trajectory format or a persisted representation. */
export type AgentResourceSnapshotPage =
  | { readonly stream: "nativeRecords"; readonly records: readonly NativeTrajectoryEntry[] }
  | { readonly stream: "usageEvents" | "billingSettlements"; readonly records: readonly AgentResourceFact[] };

/** New SP collection never assembles the legacy arrays in JS. The Harness finishes every
 * authenticated page and reference read before returning this sealed, replayable download;
 * Runtime disposes it after the atomic Store write (including uncertain/retried writes). */
export interface AgentResourceSnapshotDownload {
  readonly kind: "pages";
  readonly summary: AgentResourceSnapshotSummary;
  /** Payload-free diagnostic, never a substitute for Metrics or persisted billing. */
  readonly creditsTotal: number | null;
  readPages(): AsyncIterable<AgentResourceSnapshotPage>;
  dispose(): Promise<void>;
}

export type CollectedResourceSnapshot = AgentResourceSnapshot | AgentResourceSnapshotDownload;
export function isResourceSnapshotDownload(value: CollectedResourceSnapshot): value is AgentResourceSnapshotDownload {
  return value !== null && typeof value === "object" && "kind" in value && value.kind === "pages";
}

interface AgentResourceDownloads {
  /** Downloads started since the last stored snapshot, saved before each one so a crash also counts. */
  readonly downloads?: number;
}

interface AgentResourcesGivenUp {
  /** The download retry budget is spent; Runtime no longer owes this Attempt's resources. */
  readonly exhausted?: true;
}

type PendingAgentResources = AgentResourceDownloads & {
  readonly exhausted?: never;
  readonly status: "pending";
  readonly scope: AgentResourceScope;
};

type FailedAgentResources = AgentResourceDownloads & AgentResourcesGivenUp & {
  readonly status: "failed";
  readonly scope: AgentResourceScope;
  readonly collectedAt: string;
  readonly error: string;
};

type CollectedAgentResourceState = AgentResourceDownloads & AgentResourcesGivenUp & {
  readonly status: "collected";
  readonly summary: AgentResourceSnapshotSummary;
};

/** An Attempt's resources as its stage record stores them. */
export type AgentResourceState = PendingAgentResources | FailedAgentResources | CollectedAgentResourceState;

/** A resource state with its stored snapshot loaded; read one record at a time. */
export type AgentResourceCollection =
  | PendingAgentResources
  | FailedAgentResources
  | CollectedAgentResourceState & { readonly snapshot: AgentResourceSnapshot };
