import type { JsonValue } from "./model.js";

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
  readonly telemetryEvents: AgentResourceCompleteness;
  readonly billingSettlements: AgentResourceCompleteness;
}

export interface AgentResourceSnapshot {
  readonly scope: SubmittedAgentResourceScope;
  readonly observedAt: string;
  readonly finalized: boolean;
  readonly coverage: AgentResourceCoverage;
  readonly trajectoryFormat?: string;
  readonly usageEvents: readonly AgentResourceFact[];
  readonly telemetryEvents: readonly AgentResourceFact[];
  readonly billingSettlements: readonly AgentResourceFact[];
  /** SP's own explanation of why `finalized` is false; diagnostic only, never a second completeness signal. */
  readonly readiness?: AgentResourceReadiness;
}

export interface AgentResourceReadiness {
  readonly receiptTerminal: boolean;
  readonly stateUnreadable: boolean;
  readonly pendingTelemetryEvents: number | null;
  readonly pendingRuntimeEvents: number | null;
  /** The unmodified public SP delivery state. Absent only on immutable historical records. */
  readonly trajectory?: AgentTrajectoryDeliveryState;
  readonly runtimeBusiness?: AgentRuntimeBusinessDeliveryState;
  readonly actionCharges: {
    readonly complete: boolean;
    readonly unsettledExecutions: number;
    readonly missingExecutionIds: number;
  };
}

export interface AgentTrajectoryScope {
  readonly resource: { readonly agentId: string; readonly sessionId: string };
  readonly submissionId: string;
}

/** Stored public wire data, not a locally inferred execution tree. */
export interface AgentTrajectoryDeliveryState {
  readonly resource: AgentTrajectoryScope["resource"] | null;
  readonly submissionId: string | null;
  readonly status: "delivered" | "pending" | "failed" | "quarantined" | "missing" | "unreadable";
  readonly requiredClosed: boolean;
  readonly pendingRecords: number | null;
  readonly children: readonly AgentTrajectoryDeliveryState[];
  readonly error?: string;
}

export interface AgentRuntimeBusinessDeliveryState {
  readonly actor: {
    readonly resource: AgentTrajectoryScope["resource"] | null;
    readonly path: readonly { readonly className: string; readonly name: string }[];
  };
  readonly submissionId: string | null;
  readonly status: AgentTrajectoryDeliveryState["status"];
  readonly pendingRuntimeEvents: number | null;
  readonly quarantinedRuntimeEvents: number | null;
  readonly children: readonly AgentRuntimeBusinessDeliveryState[];
  readonly error?: string;
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
  readonly telemetryEvents: number;
  readonly billingSettlements: number;
}

/** What a stage record keeps of a stored snapshot; its events live only in the resource store. */
export type AgentResourceSnapshotSummary = Omit<AgentResourceSnapshot, "usageEvents" | "telemetryEvents" | "billingSettlements"> & {
  readonly counts: AgentResourceCounts;
};

export function summarizeResourceSnapshot(snapshot: AgentResourceSnapshot): AgentResourceSnapshotSummary {
  const { usageEvents, telemetryEvents, billingSettlements, ...summary } = snapshot;
  return {
    ...summary,
    counts: { usageEvents: usageEvents.length, telemetryEvents: telemetryEvents.length, billingSettlements: billingSettlements.length },
  };
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
