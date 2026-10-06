import type { EvaluatorResult, JsonValue } from "@eval-platform/eval-contracts";

export interface MetricValue {
  readonly metricId: string;
  readonly score?: number;
  readonly status: "available" | "unavailable";
  readonly details?: JsonValue;
}

export interface MetricSummary {
  readonly scope: "sample" | "sampling" | "project";
  readonly subjectId: string;
  readonly values: readonly MetricValue[];
}

export interface MetricAggregator {
  aggregate(results: readonly EvaluatorResult[]): MetricSummary;
}
