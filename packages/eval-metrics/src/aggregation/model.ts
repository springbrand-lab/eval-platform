import type {
  AgentConfigRef,
  AgentResourceCollection,
  AgentResourceCompleteness,
  AgentResourceScope,
  EvaluationRecord,
  SamplingStatus,
} from "@eval-platform/eval-contracts";
import type { SamplingSnapshot } from "@eval-platform/eval-runtime";

export interface MetricNumber {
  readonly value: number | null;
  readonly coverage: AgentResourceCompleteness;
}

export interface NumericSummary {
  readonly count: number;
  readonly missing: number;
  readonly total: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly median: number | null;
}

export interface TokenStatistics {
  readonly input: MetricNumber;
  readonly output: MetricNumber;
  readonly cacheRead: MetricNumber;
  readonly cacheWrite: MetricNumber;
  readonly reasoning: MetricNumber;
  readonly total: MetricNumber;
}

export interface CostStatistics {
  readonly providerUsd: MetricNumber;
  readonly modelDebitedUnits: MetricNumber;
  readonly actionChargedUnits: MetricNumber;
  readonly chargedUnits: MetricNumber;
  readonly ratedUnits: MetricNumber;
  readonly shortfallUnits: MetricNumber;
  readonly platformOwnedUnits: MetricNumber;
}

export interface OperationStatistics {
  readonly count: MetricNumber;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly inProgress: number;
  readonly unknown: number;
  readonly durationMs: NumericSummary;
}

export interface ToolStatistics extends OperationStatistics {
  readonly toolName: string | null;
}

export interface ModelStatistics {
  readonly provider: string | null;
  readonly model: string | null;
  readonly usageRecords: number;
  readonly tokens: TokenStatistics;
  readonly providerUsd: MetricNumber;
}

export interface ResourceDiagnostic {
  readonly kind: "missing-identity" | "conflicting-identity" | "unsupported-record" | "invalid-value";
  readonly stream: "usageEvents" | "telemetryEvents" | "billingSettlements";
  readonly message: string;
  readonly scope: AgentResourceScope;
  readonly eventId?: string;
}

export interface ResourceStatistics {
  readonly collections: {
    readonly collected: number;
    readonly pending: number;
    readonly failed: number;
    readonly unsubmitted: number;
    readonly finalized: number;
  };
  readonly duplicateRecords: {
    readonly usageEvents: number;
    readonly telemetryEvents: number;
    readonly billingSettlements: number;
  };
  readonly overlappingUsageRecords: number;
  readonly tokens: TokenStatistics;
  readonly costs: CostStatistics;
  readonly modelRequests: OperationStatistics;
  readonly turns: OperationStatistics;
  readonly tools: OperationStatistics;
  readonly byTool: readonly ToolStatistics[];
  readonly byModel: readonly ModelStatistics[];
  readonly diagnostics: readonly ResourceDiagnostic[];
}

export interface ResourceInput {
  readonly ownerUserId: string;
  readonly collection: AgentResourceCollection | undefined;
}

export interface StageStatistics {
  readonly records: number;
  readonly statuses: Readonly<Record<SamplingStatus, number>>;
  readonly terminalRecords: number;
  readonly successRate: number | null;
  readonly attempts: number;
  readonly restarts: number;
  readonly completedAttempts: number;
  readonly failedAttempts: number;
  readonly interruptedAttempts: number;
  readonly cancelledAttempts: number;
  readonly agentDurationMs: NumericSummary;
}

export interface EvaluatorScoreStatistics {
  readonly evaluator: AgentConfigRef;
  readonly evaluations: number;
  readonly unavailable: number;
  readonly invalid: number;
  readonly scores: NumericSummary;
}

export interface MetricSummary {
  readonly samplingCount: number;
  readonly evaluationCount: number;
  readonly execution: StageStatistics;
  readonly evaluation: StageStatistics;
  readonly scores: readonly EvaluatorScoreStatistics[];
  readonly resources: {
    readonly execution: ResourceStatistics;
    readonly evaluation: ResourceStatistics;
    readonly total: ResourceStatistics;
  };
}

export interface MetricInput {
  readonly samplings: readonly SamplingSnapshot[];
  readonly evaluations: readonly EvaluationRecord[];
}
