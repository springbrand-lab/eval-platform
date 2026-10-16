// Response shapes of the Eval API. Package types are imported as types only; app-level views are mirrored here.
import type {
  AgentConfigRef,
  AgentObservationRef,
  AgentRole,
  EvaluationOutputSchema,
  EvaluationRecord,
  Project,
  ProjectPlan,
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
export type {
  DatasetOverview,
  EvaluationDetail,
  MetricSummary,
  ProjectOverview,
  SampleOverview,
  SamplingDetail,
  AgentMetricView,
  ResourceStatistics,
  EvaluationOutputView,
  EvaluationOutputSummary,
  OutputFieldSummary,
  StageStatistics,
} from "@eval-platform/eval-metrics";

export interface CurrentRun {
  readonly runId: string;
  readonly stopRequested?: true;
}

export interface ProjectView extends ProjectPlan {
  readonly projectSamples: readonly ProjectSample[];
  readonly currentRun: CurrentRun | null;
}

export interface Me {
  readonly id: string;
  readonly role: "user" | "admin" | "super_admin";
}

export interface AgentConfig {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly slug?: string;
  readonly description?: string | null;
  readonly revision?: number;
  readonly setting?: unknown;
  readonly [field: string]: unknown;
}

export interface AgentOption {
  readonly agentConfig: AgentConfigRef;
  readonly name: string;
  readonly role: AgentRole;
}

export interface AgentPolicyInput {
  readonly userAgentId: string;
  readonly retryPolicy?: RetryPolicy;
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
