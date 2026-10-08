import type {
  EvaluationRecord,
  Project,
  RunSnapshot,
} from "@eval-platform/eval-contracts";
import type { Dataset, DatasetSnapshot } from "@eval-platform/eval-dataset";
import type { Sample, SamplingSnapshot } from "@eval-platform/eval-runtime";
import type { MetricSummary, ResourceStatistics } from "../aggregation/model.js";
import type { EvaluationMetrics } from "../evaluators/model.js";

export interface MetricsScope {
  readonly projectId: string;
  readonly runIds?: readonly string[];
}

export interface DatasetMetricsQuery extends MetricsScope {
  readonly datasetId: string;
}

export interface SampleMetricsQuery extends MetricsScope {
  readonly sampleId: string;
}

export interface SamplingMetricsQuery extends MetricsScope {
  readonly samplingId: string;
}

export type MetricsQuery = MetricsScope & {
  readonly datasetId?: string;
  readonly sampleId?: string;
  readonly samplingId?: string;
};

export interface MetricsFacts {
  readonly project: Project;
  readonly datasets: readonly DatasetSnapshot[];
  readonly samples: readonly Sample[];
  readonly samplings: readonly SamplingSnapshot[];
  readonly evaluations: readonly EvaluationRecord[];
  readonly runs: readonly RunSnapshot[];
}

export interface MetricsSource {
  read(query: MetricsQuery): Promise<MetricsFacts>;
}

export interface OverviewCounts {
  readonly datasets: number;
  readonly data: number;
  readonly samples: number;
  readonly samplings: number;
  readonly evaluations: number;
}

export interface DatasetMetricRow {
  readonly dataset: Dataset;
  readonly counts: OverviewCounts;
  readonly summary: MetricSummary;
}

export interface SampleMetricRow {
  readonly sampleId: string;
  readonly dataId: string;
  readonly summary: MetricSummary;
}

export interface SamplingMetricRow {
  readonly samplingId: string;
  readonly summary: MetricSummary;
  readonly artifactCount: number;
  readonly hasTrajectory: boolean;
}

export interface ProjectOverview {
  readonly project: Project;
  readonly runIds: readonly string[];
  readonly counts: OverviewCounts;
  readonly summary: MetricSummary;
  readonly datasets: readonly DatasetMetricRow[];
}

export interface DatasetOverview extends DatasetMetricRow {
  readonly project: Project;
  readonly runIds: readonly string[];
  readonly dataIds: readonly string[];
  readonly samples: readonly SampleMetricRow[];
}

export interface SampleOverview {
  readonly project: Project;
  readonly runIds: readonly string[];
  readonly sample: Sample;
  readonly datasetIds: readonly string[];
  readonly counts: OverviewCounts;
  readonly summary: MetricSummary;
  readonly samplings: readonly SamplingMetricRow[];
}

export interface EvaluationDetail {
  readonly record: EvaluationRecord;
  readonly result: EvaluationMetrics;
  readonly resources: ResourceStatistics;
}

export interface SamplingDetail {
  readonly project: Project;
  readonly runIds: readonly string[];
  readonly sample: Sample;
  readonly datasetIds: readonly string[];
  readonly sampling: SamplingSnapshot;
  readonly summary: MetricSummary;
  readonly evaluations: readonly EvaluationDetail[];
}

export interface Metrics {
  getProjectOverview(query: MetricsScope): Promise<ProjectOverview>;
  getDatasetOverview(query: DatasetMetricsQuery): Promise<DatasetOverview>;
  getSampleOverview(query: SampleMetricsQuery): Promise<SampleOverview>;
  getSamplingDetail(query: SamplingMetricsQuery): Promise<SamplingDetail>;
}
