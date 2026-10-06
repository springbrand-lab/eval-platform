import type { HarnessConfig, RetryPolicy } from "@eval-platform/eval-contracts";

export interface ExecutionConfig {
  readonly configId: string;
  readonly datasetId: string;
  readonly harness: HarnessConfig;
  readonly samplingCount: number;
  readonly executionConcurrency: number;
  readonly retryPolicy?: RetryPolicy;
}

export interface EvaluationConfig {
  readonly configId: string;
  readonly evaluationHarness: HarnessConfig;
  readonly evaluationConcurrency: number;
  readonly retryPolicy?: RetryPolicy;
}

export type PipelineTrigger = "manual" | "execution.completed" | "retry-evaluation";

export interface PipelineConfig {
  readonly trigger: PipelineTrigger;
  readonly executionConfigId: string;
  readonly evaluationConfigId: string;
}
