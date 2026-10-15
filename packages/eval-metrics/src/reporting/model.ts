import type {
  EvaluationOutputSchema,
  EvaluationRecord,
  Project,
  ProjectDatasetSnapshot,
  ProjectPlan,
  RunSnapshot,
  SamplingStageState,
} from "@eval-platform/eval-contracts";
import type { ProjectSample, SamplingSnapshot } from "@eval-platform/eval-runtime";
import type { AgentMetricView, MetricSummary } from "../aggregation/model.js";
import type { EvaluationOutputView } from "../evaluators/model.js";

export interface MetricsScope {
  readonly projectId: string;
  /** Optional "this batch" filter on Samplings and EvaluationRecords; never changes the fixed hierarchy. */
  readonly runIds?: readonly string[];
}

export interface DatasetMetricsQuery extends MetricsScope {
  readonly datasetId: string;
}

export interface SampleMetricsQuery extends MetricsScope {
  readonly projectSampleId: string;
}

export interface SamplingMetricsQuery extends MetricsScope {
  readonly samplingId: string;
}

export type MetricsQuery = MetricsScope & {
  readonly datasetId?: string;
  readonly projectSampleId?: string;
  readonly samplingId?: string;
};

/**
 * One repeatable-read snapshot of a Project. The hierarchy comes only from the fixed plan, never from
 * live catalog Datasets or Data.
 */
export interface MetricsFacts {
  readonly plan: ProjectPlan;
  /** Content of the evaluation plan's Schema; null without an evaluation plan. */
  readonly evaluationOutputSchema: EvaluationOutputSchema | null;
  /**
   * Every bound ProjectSample in the queried scope, including never-run ones: all of the Project's for
   * a Project query, the Dataset's for a Dataset query, and the single target for Sample/Sampling queries.
   */
  readonly projectSamples: readonly ProjectSample[];
  /** Current Samplings of `projectSamples`, restricted to `runIds` when given. */
  readonly samplings: readonly SamplingSnapshot[];
  /** Current EvaluationRecords of `samplings`, restricted to `runIds` when given. */
  readonly evaluations: readonly EvaluationRecord[];
  /** Selected Runs, or every Run that still has a current member in scope. */
  readonly runs: readonly RunSnapshot[];
}

export interface MetricsSource {
  read(query: MetricsQuery): Promise<MetricsFacts>;
}

/** A Dataset as bound in the Project plan, summarized over its bound ProjectSamples. */
export interface DatasetMetricRow {
  readonly dataset: ProjectDatasetSnapshot;
  readonly summary: MetricSummary;
}

export interface ProjectSampleMetricRow {
  readonly projectSampleId: string;
  readonly dataId: string;
  readonly datasetIds: readonly string[];
  /** Fixed planned Samplings per execution; `summary.counts.samplings` is the current number. */
  readonly samplingCount: number;
  readonly summary: MetricSummary;
}

export interface SamplingMetricRow {
  readonly samplingId: string;
  readonly execution: SamplingStageState;
  readonly summary: MetricSummary;
  readonly artifactCount: number;
  readonly hasTrajectory: boolean;
}

interface ScopedView {
  readonly project: Project;
  /** The selected Runs, or every Run with a current member in this view. */
  readonly runIds: readonly string[];
  readonly summary: MetricSummary;
}

/** Shared ProjectSamples appear in every Dataset row; the Project summary counts each Sampling once. */
export interface ProjectOverview extends ScopedView {
  readonly datasets: readonly DatasetMetricRow[];
}

export interface DatasetOverview extends ScopedView {
  readonly dataset: ProjectDatasetSnapshot;
  /** Every bound ProjectSample in Dataset member order, including never-run ones. */
  readonly projectSamples: readonly ProjectSampleMetricRow[];
}

export interface SampleOverview extends ScopedView {
  readonly projectSample: ProjectSample;
  readonly samplings: readonly SamplingMetricRow[];
}

export interface EvaluationDetail {
  readonly record: EvaluationRecord;
  readonly agent: AgentMetricView;
  readonly output: EvaluationOutputView;
}

export interface SamplingDetail extends ScopedView {
  readonly projectSample: ProjectSample;
  readonly sampling: SamplingSnapshot;
  readonly subject: AgentMetricView;
  readonly evaluations: readonly EvaluationDetail[];
}

export interface Metrics {
  getProjectOverview(query: MetricsScope): Promise<ProjectOverview>;
  getDatasetOverview(query: DatasetMetricsQuery): Promise<DatasetOverview>;
  getSampleOverview(query: SampleMetricsQuery): Promise<SampleOverview>;
  getSamplingDetail(query: SamplingMetricsQuery): Promise<SamplingDetail>;
}
