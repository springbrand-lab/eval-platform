import type {
  AgentConfigRef,
  AgentResourceCollection,
  AgentResourceCompleteness,
  AgentResourceState,
  EvaluationAttempt,
  EvaluationRecord,
  ExecutionAttempt,
  AgentResourceScope,
  AgentRole,
  AgentStatus,
  ArtifactRef,
  EvaluationOutputSchemaRef,
  SamplingStageState,
  SamplingStatus,
  TrajectoryRef,
} from "@eval-platform/eval-contracts";
import type { SamplingSnapshot } from "@eval-platform/eval-runtime";
import type { EvaluationValidationStatus, OutputFieldDefinition, OutputScalar } from "../evaluators/model.js";

/** An Attempt whose collected resources carry their stored snapshot. */
export type WithResourceSnapshot<T extends { readonly resources?: AgentResourceState }> = Omit<T, "resources"> & {
  readonly resources?: AgentResourceCollection;
};

/** A Sampling whose collected Attempt resources carry their stored snapshots. */
export type MetricsSampling = Omit<SamplingSnapshot, "executionAttempts"> & {
  readonly executionAttempts: readonly WithResourceSnapshot<ExecutionAttempt>[];
};

/** An EvaluationRecord whose collected Attempt resources carry their stored snapshots. */
export type MetricsEvaluation = Omit<EvaluationRecord, "attempts"> & {
  readonly attempts: readonly WithResourceSnapshot<EvaluationAttempt>[];
};

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
  /** Population variance over available values only (divide by `count`), in squared units. */
  readonly variance: number | null;
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

/** Tokens of model steps explicitly marked as thinking or content; never derived by subtraction. */
export interface StepTokens {
  readonly input: MetricNumber;
  readonly output: MetricNumber;
  readonly total: MetricNumber;
}

export type ThinkingStepTokens = StepTokens;
export type ContentStepTokens = StepTokens;

export interface TrajectorySummary {
  readonly coverage: AgentResourceCompleteness;
  readonly turns: OperationStatistics;
  readonly compactions: OperationStatistics;
  readonly deferredPolls: OperationStatistics;
  readonly modelInvocations: OperationStatistics;
  /** Distinct native task identities, never inferred from retry/poll counts. Unavailable for v1 archives. */
  readonly generationTasks: MetricNumber;
  readonly requestRetries: { readonly generation: MetricNumber; readonly compaction: MetricNumber };
  readonly tools: OperationStatistics;
  readonly byTool: readonly ToolMetric[];
  /** Model steps whose output or owning Turn contains thinking/signature markers. */
  readonly thinkingSteps: MetricNumber;
  /** Status and duration of the marked model steps counted by `thinkingSteps`. */
  readonly thinkingStepOperations: OperationStatistics;
  /** Model steps whose output or owning Turn contains a content marker. */
  readonly contentSteps: MetricNumber;
  /** Status and duration of the marked model steps counted by `contentSteps`. */
  readonly contentStepOperations: OperationStatistics;
  /** Tokens of thinking-marked model steps; may overlap contentStepTokens. */
  readonly thinkingStepTokens: ThinkingStepTokens;
  /** Tokens of content-marked model steps; may overlap thinkingStepTokens. */
  readonly contentStepTokens: ContentStepTokens;
  /** Tool/model operations whose parent Turn cannot be resolved through parentOperationId. */
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
  /** Cache reads divided by input plus cache reads, with the source coverage preserved. */
  readonly cacheHitRate: MetricNumber;
  readonly costs: CostStatistics;
  readonly modelRequests: OperationStatistics;
  readonly trajectory: TrajectorySummary;
  readonly byModel: readonly ModelStatistics[];
  readonly diagnostics: readonly ResourceDiagnostic[];
}

export type NumericDistributions<T> = { readonly [K in keyof T]: CoveredNumericSummary };

export interface OperationDistributions {
  readonly count: CoveredNumericSummary;
  readonly completed: CoveredNumericSummary;
  readonly failed: CoveredNumericSummary;
  readonly cancelled: CoveredNumericSummary;
  readonly inProgress: CoveredNumericSummary;
  readonly unknown: CoveredNumericSummary;
}

/** Single-Agent observations, never observations made from child-scope aggregates. */
export interface ResourceDistribution {
  readonly unit: "agent";
  readonly records: number;
  readonly tokens: NumericDistributions<TokenStatistics>;
  readonly costs: NumericDistributions<CostStatistics>;
  readonly modelRequests: OperationDistributions;
  readonly trajectory: {
    readonly turns: OperationDistributions;
    readonly tools: OperationDistributions;
    readonly thinkingSteps: CoveredNumericSummary;
    readonly thinkingStepOperations: OperationDistributions;
    readonly contentSteps: CoveredNumericSummary;
    readonly contentStepOperations: OperationDistributions;
    readonly thinkingStepTokens: NumericDistributions<ThinkingStepTokens>;
    readonly contentStepTokens: NumericDistributions<ContentStepTokens>;
    readonly byTool: readonly { readonly toolName: string | null; readonly operations: OperationDistributions }[];
  };
  readonly byModel: readonly {
    readonly provider: string | null;
    readonly model: string | null;
    readonly tokens: NumericDistributions<TokenStatistics>;
    readonly providerUsd: CoveredNumericSummary;
  }[];
}

export interface AggregatedResourceStatistics extends ResourceStatistics {
  readonly distribution: ResourceDistribution;
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

export type OutputMissingReason = "not-succeeded" | "invalid-output" | "unavailable-output" | "absent";

export interface OutputValueEntry {
  readonly value: OutputScalar;
  /** Occurrences; an array field can hold several per evaluation. */
  readonly count: number;
  /** `count / observationCount`, whose denominator includes nulls and values outside the distribution; null without observations. */
  readonly share: number | null;
  /** Evaluations containing the value at least once. */
  readonly evaluations: number;
}

export interface OutputFieldSummary extends Pick<OutputFieldDefinition, "jsonPointer" | "title" | "description" | "kinds"> {
  /** Aggregated values including null; an array field can yield several per evaluation. */
  readonly observationCount: number;
  readonly contributingEvaluationCount: number;
  readonly missingEvaluationCount: number;
  /** Over numeric values only; null when the field has no number/integer kind. */
  readonly numeric: NumericSummary | null;
  /** Boolean and enum values of the field shape: declared values in Schema order, then reached values in first-seen order. */
  readonly distribution: readonly OutputValueEntry[];
  /** Null occurrences; present exactly when the field shape allows null. */
  readonly nullCount?: number;
  readonly coverage: AgentResourceCompleteness;
  /** Why evaluations in scope did not contribute; only non-zero reasons. */
  readonly diagnostics: readonly { readonly reason: OutputMissingReason; readonly evaluations: number }[];
}

export interface EvaluationOutputSummary {
  /** The locked Project Schema; null without an evaluation plan. */
  readonly schema: EvaluationOutputSchemaRef | null;
  readonly coverage: AgentResourceCompleteness;
  readonly evaluations: number;
  readonly validation: Readonly<Record<EvaluationValidationStatus, number>>;
  /** Aggregated fields in Schema order, then fields the static walk cannot name (map keys, recursion) in first-seen order. */
  readonly fields: readonly OutputFieldSummary[];
}

/** Every field is recomputed from the raw records in scope, never from child summaries. */
export interface MetricSummary {
  readonly counts: MetricCounts;
  readonly execution: StageStatistics;
  readonly evaluation: StageStatistics;
  readonly executionAgent: AggregatedResourceStatistics;
  readonly evaluationAgents: AggregatedResourceStatistics;
  readonly evaluationOutputs: EvaluationOutputSummary;
}
