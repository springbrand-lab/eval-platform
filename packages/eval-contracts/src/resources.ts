import type { JsonValue } from "./model.js";

export interface AgentResourceScope {
  readonly submissionId: string;
  readonly idempotencyKey: string;
}

export type AgentResourceFact = Readonly<Record<string, JsonValue>>;

export type AgentResourceCompleteness = "complete" | "partial" | "unavailable";

export interface AgentResourceCoverage {
  readonly usageEvents: AgentResourceCompleteness;
  readonly telemetryEvents: AgentResourceCompleteness;
  readonly billingSettlements: AgentResourceCompleteness;
}

export interface AgentResourceSnapshot {
  readonly scope: AgentResourceScope;
  readonly observedAt: string;
  readonly finalized: boolean;
  readonly coverage: AgentResourceCoverage;
  readonly usageEvents: readonly AgentResourceFact[];
  readonly telemetryEvents: readonly AgentResourceFact[];
  readonly billingSettlements: readonly AgentResourceFact[];
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
