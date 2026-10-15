import type {
  AgentConfigRef,
  AgentResourceCompleteness,
  AgentResourceScope,
  AgentRole,
  AgentStatus,
  ArtifactRef,
  EvaluationOutputSchemaRef,
  SamplingStageState,
  SamplingStatus,
  TrajectoryRef,
} from "@eval-platform/eval-contracts";
import type { EvaluationValidationStatus, NumericSchemaType } from "../evaluators/model.js";

export interface MetricNumber {
  readonly value: number | null;
  readonly coverage: AgentResourceCompleteness;
}

/** `count` values were available and `missing` were not; missing values never count as zero. */
export interface NumericSummary {
  readonly count: number;
  readonly missing: number;
  readonly total: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly median: number | null;
}

export interface CoveredNumericSummary extends NumericSummary {
  readonly coverage: AgentResourceCompleteness;
}

export interface TokenStatistics {
  readonly input: MetricNumber;
  readonly output: MetricNumber;
  readonly cacheRead: MetricNumber;
  readonly cacheWrite: MetricNumber;
  /** A subset of output tokens; never added to `total` again. */
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
  /** Per-operation durations; never a batch wall-clock time. */
  readonly durationMs: NumericSummary;
}

export interface ToolMetric extends OperationStatistics {
  readonly toolName: string | null;
  /** UTF-8 bytes of the canonical JSON of `tool.started` payload.input; not tokens. */
  readonly inputLength: CoveredNumericSummary;
  /** UTF-8 bytes of the canonical JSON of `tool.finished` payload.output, else payload.response; never both. */
  readonly outputLength: CoveredNumericSummary;
}

/** Tokens of generations explicitly linked to a Turn without tool operations; never derived by subtraction. */
export interface NonToolTurnTokens {
  readonly input: MetricNumber;
  readonly output: MetricNumber;
  readonly total: MetricNumber;
}

export interface TrajectorySummary {
  readonly coverage: AgentResourceCompleteness;
  readonly turns: OperationStatistics;
  readonly tools: OperationStatistics;
  readonly byTool: readonly ToolMetric[];
  readonly nonToolTurns: MetricNumber;
  readonly nonToolTurnTokens: NonToolTurnTokens;
  /** Operations whose Turn cannot be resolved through parentOperationId. */
  readonly unlinkedOperations: { readonly tools: number; readonly generations: number };
  readonly diagnostics: readonly ResourceDiagnostic[];
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
  /** complete only when every submitted Attempt was collected, finalized and declared complete without diagnostics. */
  readonly coverage: AgentResourceCompleteness;
  readonly collections: {
    readonly collected: number;
    readonly pending: number;
    readonly failed: number;
    /** Submitted Attempts without any collection record. */
    readonly uncollected: number;
    /** Attempts that never reached SP; they do not make resources incomplete. */
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
  readonly trajectory: TrajectorySummary;
  readonly byModel: readonly ModelStatistics[];
  readonly diagnostics: readonly ResourceDiagnostic[];
}

export interface AttemptMetric {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly status: AgentStatus;
  readonly submissionId: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly resourceCollection: "collected" | "pending" | "failed" | "uncollected" | "unsubmitted";
}

/** One Agent (the Subject of a Sampling or one Evaluator) with its own Chat, Attempts and resources. */
export interface AgentMetricView {
  readonly role: AgentRole;
  readonly agentConfigRef: AgentConfigRef;
  readonly chatId: string | null;
  readonly samplingId: string;
  readonly evaluationId: string | null;
  readonly stage: SamplingStageState;
  readonly attempts: {
    readonly count: number;
    readonly restarts: number;
    readonly items: readonly AttemptMetric[];
  };
  readonly firstStartedAt: string | null;
  /** Null until the latest Attempt is terminal. */
  readonly lastCompletedAt: string | null;
  /** First valid Attempt start to last terminal completion, including restart gaps. */
  readonly agentDurationMs: number | null;
  readonly resources: ResourceStatistics;
  readonly artifacts: readonly ArtifactRef[];
  readonly trajectory: TrajectoryRef | null;
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
  readonly attemptDurationMs: NumericSummary;
}

export interface MetricCounts {
  /** Fixed bindings from the Project snapshot. */
  readonly datasets: number;
  readonly data: number;
  readonly projectSamples: number;
  /** Current results in scope. */
  readonly samplings: number;
  readonly evaluations: number;
}

export type NumericMissingReason = "not-succeeded" | "invalid-output" | "unavailable-output" | "absent";

export interface NumericObservationSummary {
  readonly jsonPointer: string;
  readonly schemaType: NumericSchemaType;
  /** Values; an array field can yield several per evaluation. */
  readonly observationCount: number;
  readonly contributingEvaluationCount: number;
  readonly missingEvaluationCount: number;
  readonly summary: NumericSummary;
  readonly coverage: AgentResourceCompleteness;
  /** Why evaluations in scope did not contribute; only non-zero reasons. */
  readonly diagnostics: readonly { readonly reason: NumericMissingReason; readonly evaluations: number }[];
}

export interface NumericOutputSummary {
  /** The locked Project Schema; null without an evaluation plan. */
  readonly schema: EvaluationOutputSchemaRef | null;
  readonly coverage: AgentResourceCompleteness;
  readonly evaluations: number;
  readonly validation: Readonly<Record<EvaluationValidationStatus, number>>;
  /** Schema-declared numeric fields in Schema order, then observed fields the static walk cannot name (map keys, recursion). */
  readonly fields: readonly NumericObservationSummary[];
}

/** Every field is recomputed from the raw records in scope, never from child summaries. */
export interface MetricSummary {
  readonly counts: MetricCounts;
  readonly execution: StageStatistics;
  readonly evaluation: StageStatistics;
  readonly executionAgent: ResourceStatistics;
  readonly evaluationAgents: ResourceStatistics;
  readonly numericOutputs: NumericOutputSummary;
}
