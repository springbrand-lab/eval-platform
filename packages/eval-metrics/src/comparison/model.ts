import type { AgentFramework, Project } from "@eval-platform/eval-contracts";
import type { Data } from "@eval-platform/eval-dataset";
import type { CoveredNumericSummary, MetricNumber, NumericSummary, OutputFieldSummary } from "../aggregation/model.js";
import type { OutputFieldDefinition } from "../evaluators/model.js";
import type { MetricsFacts } from "../reporting/model.js";

export interface ProjectComparisonQuery {
  readonly projectIds: readonly string[];
  readonly datasetId?: string;
  readonly jsonPointer?: string;
}

export interface ProjectComparisonSource {
  read(projectIds: readonly string[]): Promise<readonly MetricsFacts[]>;
}

export interface ComparisonProject {
  readonly project: Project;
  readonly executionAgentName: string;
  readonly evaluationAgentName: string | null;
  readonly framework: AgentFramework;
  readonly executionModel: string | null;
}

export interface ComparisonField extends OutputFieldDefinition {
  readonly dataCount: number;
}

export interface ComparisonResources {
  readonly chargedUnits: MetricNumber;
  readonly chargedUnitsPerAgent: CoveredNumericSummary;
  readonly agentDurationMs: NumericSummary;
  readonly cacheHitRate: MetricNumber;
  readonly toolSuccessRate: MetricNumber;
}

export interface ComparisonProjectValues {
  readonly projectId: string;
  readonly dataCount: number;
  readonly samplingCount: number;
  readonly evaluationCount: number;
  readonly score: OutputFieldSummary | null;
  readonly resources: ComparisonResources;
}

export interface ComparisonDataProjectValues extends ComparisonProjectValues {
  readonly projectSampleId: string;
  readonly samplingIds: readonly string[];
}

export interface ComparisonDataRow {
  readonly dataId: string;
  readonly data: Data;
  readonly datasetIds: readonly string[];
  readonly inputChanged: boolean;
  readonly projects: readonly ComparisonDataProjectValues[];
  readonly spread: number | null;
  readonly different: boolean;
}

export interface ComparisonDataset {
  readonly datasetId: string;
  readonly name: string;
  readonly dataCount: number;
}

export interface ProjectComparisonView {
  readonly projects: readonly ComparisonProject[];
  readonly fields: readonly ComparisonField[];
  readonly selectedField: ComparisonField | null;
  readonly datasets: readonly ComparisonDataset[];
  readonly datasetId: string | null;
  readonly summary: readonly ComparisonProjectValues[];
  readonly rows: readonly ComparisonDataRow[];
}

export interface ProjectComparison {
  getComparison(query: ProjectComparisonQuery): Promise<ProjectComparisonView>;
}
