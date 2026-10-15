import type { HarnessConfig, RetryPolicy } from "@eval-platform/eval-contracts";

export interface ExecutionConfig {
  readonly configId: string;
  readonly datasetId: string;
  readonly sampleIds?: readonly string[];
  readonly harness: HarnessConfig;
  readonly samplingCount: number;
  readonly executionConcurrency: number;
  readonly retryPolicy?: RetryPolicy;
}

export interface EvaluationConfig {
  readonly configId: string;
  readonly evaluationHarness: HarnessConfig & { readonly framework: "sp" };
  readonly evaluationConcurrency: number;
  readonly retryPolicy?: RetryPolicy;
}

export interface ResolvedExecutionConfig extends Omit<ExecutionConfig, "retryPolicy"> {
  readonly retryPolicy: RetryPolicy;
}

export interface ResolvedEvaluationConfig extends Omit<EvaluationConfig, "retryPolicy"> {
  readonly retryPolicy: RetryPolicy;
}

export interface PipelineConfig {
  readonly configId: string;
  readonly executionConfigId: string;
  readonly evaluationConfigId: string;
}

export interface ResolvedPipelineConfig {
  readonly pipeline: PipelineConfig;
  readonly execution: ResolvedExecutionConfig;
  readonly evaluation: ResolvedEvaluationConfig;
}

export type RunConfigSnapshot =
  | {
      readonly operation: "execution";
      readonly execution: ResolvedExecutionConfig;
    }
  | {
      readonly operation: "evaluation";
      readonly evaluation: ResolvedEvaluationConfig;
    }
  | {
      readonly operation: "pipeline";
      readonly pipeline: PipelineConfig;
      readonly execution: ResolvedExecutionConfig;
      readonly evaluation: ResolvedEvaluationConfig;
    };

export const DEFAULT_RETRY_POLICY = {
  maxRestarts: 2,
  initialBackoffMs: 250,
  maxBackoffMs: 5_000,
} as const;

export interface ConfigStore {
  getExecutionConfig(configId: string): Promise<ExecutionConfig | null>;
  getEvaluationConfig(configId: string): Promise<EvaluationConfig | null>;
  getPipelineConfig(configId: string): Promise<PipelineConfig | null>;
}

export interface ConfigResolver {
  resolveExecutionConfig(configId: string): Promise<ResolvedExecutionConfig>;
  resolveEvaluationConfig(configId: string): Promise<ResolvedEvaluationConfig>;
  resolvePipelineConfig(configId: string): Promise<ResolvedPipelineConfig>;
}

export type ConfigIdFactory = () => string;

export interface ExecutionConfigInput {
  readonly datasetId: string;
  readonly sampleIds?: readonly string[];
  readonly harness: HarnessConfig;
  readonly samplingCount: number;
  readonly executionConcurrency: number;
  readonly retryPolicy?: RetryPolicy;
}

export interface EvaluationConfigInput {
  readonly evaluationHarness: EvaluationConfig["evaluationHarness"];
  readonly evaluationConcurrency: number;
  readonly retryPolicy?: RetryPolicy;
}

export interface PipelineConfigInput {
  readonly executionConfigId: string;
  readonly evaluationConfigId: string;
}
