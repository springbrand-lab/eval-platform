import type {
  ArtifactRef,
  AttributionResult,
  EvidenceRef,
  EvaluatorResult,
  JsonValue,
} from "@eval-platform/eval-contracts";

import type { MetricSummary } from "../aggregation/model.js";

export interface ReportCase {
  readonly sampleId: string;
  readonly samplingId: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly evaluatorResults: readonly EvaluatorResult[];
  readonly attribution?: AttributionResult;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ReportCaseFailure {
  readonly sampleId: string;
  readonly samplingId: string;
  readonly stage: "execution" | "evaluation";
  readonly message: string;
}

export interface ReportCaseGroup {
  readonly sampleId: string;
  readonly runs: readonly ReportCase[];
  readonly summary?: MetricSummary;
}

export interface ScalarAnalysis {
  readonly type: "scalar";
  readonly title: string;
  readonly value: number;
  readonly unit?: string;
}

export interface TableAnalysis {
  readonly type: "table";
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly JsonValue[])[];
}

export type ReportAnalysis = ScalarAnalysis | TableAnalysis;

export interface EvaluationReport {
  readonly projectId: string;
  readonly samplingIds: readonly string[];
  readonly cases: readonly ReportCase[];
  readonly failures: readonly ReportCaseFailure[];
  readonly analyses: readonly ReportAnalysis[];
  readonly summary?: MetricSummary;
}
