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
  readonly usageEvents: readonly AgentResourceFact[];
  readonly telemetryEvents: readonly AgentResourceFact[];
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

export type AgentResourceCollection =
  | {
    readonly status: "pending";
    readonly scope: AgentResourceScope;
  }
  | {
    readonly status: "collected";
    readonly snapshot: AgentResourceSnapshot;
  }
  | {
    readonly status: "failed";
    readonly scope: AgentResourceScope;
    readonly collectedAt: string;
    readonly error: string;
  };
