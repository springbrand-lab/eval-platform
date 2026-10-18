// Response shapes of the Eval API. Package types are imported as types only; app-level views are mirrored here.
import type {
  AgentConfigRef,
  AgentObservationRef,
  AgentPurpose,
  AgentRole,
  EvaluationOutputSchema,
  EvaluationRecord,
  Project,
  RetryPolicy,
  RunHandle,
  RunOperation,
  RunSnapshot,
  RunTargetSelector,
  RunTargets,
  Sampling,
} from "@eval-platform/eval-contracts";
import type { Data, Dataset } from "@eval-platform/eval-dataset";
import type { ProjectSample, RunPreview } from "@eval-platform/eval-runtime";

export type {
  AgentObservationRef,
  AgentPurpose,
  AgentRole,
  Data,
  Dataset,
  EvaluationRecord,
  Project,
  ProjectSample,
  RunHandle,
  RunOperation,
  RunPreview,
  RunSnapshot,
  RunTargetSelector,
  RunTargets,
  Sampling,
};
export type { ProjectView } from "@eval-platform/eval-runtime";
export type {
  DatasetOverview,
  EvaluationDetail,
  MetricSummary,
  MetricNumber,
  NumericSummary,
  OperationStatistics,
  ProjectOverview,
  SampleOverview,
  SamplingDetail,
  AgentMetricView,
  ResourceStatistics,
  AggregatedResourceStatistics,
  ResourceDistribution,
  CoveredNumericSummary,
  OperationDistributions,
  EvaluationOutputView,
  EvaluationOutputSummary,
  OutputFieldSummary,
  StageStatistics,
} from "@eval-platform/eval-metrics";

export interface Me {
  readonly id: string;
  readonly role: "user" | "admin" | "super_admin";
}

export type { UserAgentConfig as AgentConfig } from "@springbrand/agent-config-editor/client";

export interface AgentOption {
  readonly agentConfig: AgentConfigRef;
  readonly name: string;
  /** Existing Subject/Evaluator role choice; purpose is the current Eval classification. */
  readonly role: AgentRole;
  readonly purpose: AgentPurpose;
}

export interface AgentPolicyInput {
  readonly userAgentId: string;
  readonly retryPolicy?: Pick<RetryPolicy, "maxRestarts">;
  readonly timeoutMs?: number;
}

export interface EvaluationPlanInput extends AgentPolicyInput {
  readonly evaluationConcurrency: number;
  readonly outputSchemaId: string;
}

export interface ProjectCreateInput {
  readonly idempotencyKey: string;
  readonly name: string;
  readonly description?: string;
  readonly datasets: readonly { readonly datasetId: string; readonly dataIds?: readonly string[] }[];
  readonly samplingCount: number;
  readonly samplingCounts?: Readonly<Record<string, number>>;
  readonly execution: AgentPolicyInput & { readonly framework: "sp"; readonly executionConcurrency: number };
  readonly evaluation?: EvaluationPlanInput;
  readonly run: { readonly operation: "execution" | "pipeline" };
}

export interface ScoreSyncSummary {
  readonly synced: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface BundleRecord {
  readonly bundleId: string;
  readonly name: string;
  readonly description: string;
}

export interface MaterialRecord extends BundleRecord {
  readonly materialId: string;
}

export interface SessionRecord extends BundleRecord {
  readonly sessionId: string;
  readonly format: "json" | "jsonl";
}

export interface MaterialFile {
  readonly path: string;
  readonly mediaType: string;
  readonly contentBase64: string;
}

export interface OutputSchemaRecord {
  readonly outputSchemaId: string;
  readonly name: string;
  readonly description: string;
  readonly schema: EvaluationOutputSchema;
}

export interface CreditBalance {
  readonly availableUnits: number;
  readonly topupRemainingUnits: number;
  readonly otherRemainingUnits: number;
}

export interface CreditGrant {
  readonly userId: string;
  readonly email: string;
  readonly adjustmentId: string;
  readonly units: number;
  readonly replayed: boolean;
}

export interface CreditGrantRecord {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly adjustmentId: string;
  readonly units: number;
  readonly note: string | null;
  readonly createdAt: string;
}

export type DatasetSnapshot = { readonly dataset: Dataset; readonly data: readonly Data[] };
