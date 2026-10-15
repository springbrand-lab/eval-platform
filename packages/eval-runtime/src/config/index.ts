export type {
  ConfigIdFactory,
  ConfigResolver,
  ConfigStore,
  EvaluationConfig,
  EvaluationConfigInput,
  ExecutionConfig,
  ExecutionConfigInput,
  PipelineConfig,
  PipelineConfigInput,
  ResolvedEvaluationConfig,
  ResolvedExecutionConfig,
  ResolvedPipelineConfig,
  RunConfigSnapshot,
} from "./model.js";
export { DEFAULT_RETRY_POLICY } from "./model.js";

import type { HarnessConfig, RetryPolicy } from "@eval-platform/eval-contracts";
import { AGENT_FRAMEWORKS } from "@eval-platform/eval-contracts";
import { createId } from "@springbrand/utils";
import { RuntimeEntityNotFoundError, RuntimeInputError } from "../runtime/errors.js";
import { requireDistinctIds, requireNonEmpty } from "../runtime/input.js";
import { requireRetryPolicy } from "../runtime/retry.js";
import type {
  ConfigIdFactory,
  ConfigResolver,
  ConfigStore,
  EvaluationConfig,
  EvaluationConfigInput,
  ExecutionConfig,
  ExecutionConfigInput,
  PipelineConfig,
  PipelineConfigInput,
  ResolvedEvaluationConfig,
  ResolvedExecutionConfig,
  ResolvedPipelineConfig,
} from "./model.js";
import { DEFAULT_RETRY_POLICY } from "./model.js";

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RuntimeInputError(`${field} must be a positive integer`, field);
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireConfigObject(config: unknown): void {
  if (!isObjectRecord(config)) throw new RuntimeInputError("config must be an object");
}

function validateHarnessConfig(
  harness: HarnessConfig,
  field: string,
): void {
  if (!isObjectRecord(harness)) {
    throw new RuntimeInputError(`${field} must be an object`, field);
  }
  if (harness.kind !== "sp") {
    throw new RuntimeInputError(`${field}.kind must be sp`, `${field}.kind`);
  }
  if (!(AGENT_FRAMEWORKS as readonly unknown[]).includes(harness.framework)) {
    throw new RuntimeInputError(
      `${field}.framework must be one of ${AGENT_FRAMEWORKS.join(", ")}`,
      `${field}.framework`,
    );
  }
  if (!isObjectRecord(harness.agentConfig)) {
    throw new RuntimeInputError(`${field}.agentConfig must be an object`, `${field}.agentConfig`);
  }
  requireNonEmpty(harness.agentConfig.ownerUserId, `${field}.agentConfig.ownerUserId`);
  requireNonEmpty(harness.agentConfig.userAgentId, `${field}.agentConfig.userAgentId`);
  if (harness.runtime !== undefined && !isObjectRecord(harness.runtime)) {
    throw new RuntimeInputError(`${field}.runtime must be an object`, `${field}.runtime`);
  }
  if (harness.runtime?.timeoutMs !== undefined
    && (!Number.isFinite(harness.runtime.timeoutMs) || harness.runtime.timeoutMs < 1)) {
    throw new RuntimeInputError(`${field}.runtime.timeoutMs must be a positive number`, `${field}.runtime.timeoutMs`);
  }
}

function normalizeExecutionConfig(config: ExecutionConfig): ResolvedExecutionConfig {
  requireConfigObject(config);
  requireNonEmpty(config.configId, "configId");
  requireNonEmpty(config.datasetId, "datasetId");
  if (config.sampleIds !== undefined) {
    if (!Array.isArray(config.sampleIds)) throw new RuntimeInputError("sampleIds must be an array", "sampleIds");
    if (config.sampleIds.length === 0) throw new RuntimeInputError("sampleIds must not be empty", "sampleIds");
    config.sampleIds.forEach((sampleId, index) => {
      requireNonEmpty(sampleId, `sampleIds[${index}]`);
    });
    requireDistinctIds(config.sampleIds, "sampleIds");
  }
  requirePositiveInteger(config.samplingCount, "samplingCount");
  requirePositiveInteger(config.executionConcurrency, "executionConcurrency");
  validateHarnessConfig(config.harness, "harness");
  if (config.retryPolicy !== undefined) requireRetryPolicy(config.retryPolicy);
  return {
    configId: config.configId,
    datasetId: config.datasetId,
    ...(config.sampleIds === undefined ? {} : { sampleIds: [...config.sampleIds] }),
    harness: cloneHarnessConfig(config.harness),
    samplingCount: config.samplingCount,
    executionConcurrency: config.executionConcurrency,
    retryPolicy: normalizeRetryPolicy(config.retryPolicy),
  } satisfies ResolvedExecutionConfig;
}

function normalizeEvaluationConfig(config: EvaluationConfig): ResolvedEvaluationConfig {
  requireConfigObject(config);
  requireNonEmpty(config.configId, "configId");
  requirePositiveInteger(config.evaluationConcurrency, "evaluationConcurrency");
  validateHarnessConfig(config.evaluationHarness, "evaluationHarness");
  if (config.evaluationHarness.framework !== "sp") {
    throw new RuntimeInputError("evaluationHarness must use the SP framework", "evaluationHarness.framework");
  }
  if (config.retryPolicy !== undefined) requireRetryPolicy(config.retryPolicy);
  return {
    configId: config.configId,
    evaluationHarness: {
      ...cloneHarnessConfig(config.evaluationHarness),
      framework: config.evaluationHarness.framework,
    },
    evaluationConcurrency: config.evaluationConcurrency,
    retryPolicy: normalizeRetryPolicy(config.retryPolicy),
  } satisfies ResolvedEvaluationConfig;
}

function normalizePipelineConfig(config: PipelineConfig): PipelineConfig {
  requireConfigObject(config);
  requireNonEmpty(config.configId, "configId");
  requireNonEmpty(config.executionConfigId, "executionConfigId");
  requireNonEmpty(config.evaluationConfigId, "evaluationConfigId");
  return {
    configId: config.configId,
    executionConfigId: config.executionConfigId,
    evaluationConfigId: config.evaluationConfigId,
  };
}

export function createExecutionConfig(
  input: ExecutionConfigInput,
  idFactory: ConfigIdFactory = createId,
): ResolvedExecutionConfig {
  return normalizeExecutionConfig({ ...input, configId: idFactory() });
}

export function createEvaluationConfig(
  input: EvaluationConfigInput,
  idFactory: ConfigIdFactory = createId,
): ResolvedEvaluationConfig {
  return normalizeEvaluationConfig({ ...input, configId: idFactory() });
}

export function createPipelineConfig(
  input: PipelineConfigInput,
  idFactory: ConfigIdFactory = createId,
): PipelineConfig {
  return normalizePipelineConfig({ ...input, configId: idFactory() });
}

export function createConfigResolver(store: ConfigStore): ConfigResolver {
  async function resolveExecutionConfig(configId: string): Promise<ResolvedExecutionConfig> {
    requireNonEmpty(configId, "executionConfigId");
    const config = await store.getExecutionConfig(configId);
    if (!config) throw new RuntimeEntityNotFoundError("execution-config", configId);
    return normalizeExecutionConfig(config);
  }

  async function resolveEvaluationConfig(configId: string): Promise<ResolvedEvaluationConfig> {
    requireNonEmpty(configId, "evaluationConfigId");
    const config = await store.getEvaluationConfig(configId);
    if (!config) throw new RuntimeEntityNotFoundError("evaluation-config", configId);
    return normalizeEvaluationConfig(config);
  }

  return {
    resolveExecutionConfig,
    resolveEvaluationConfig,
    async resolvePipelineConfig(configId) {
      requireNonEmpty(configId, "pipelineConfigId");
      const storedPipeline = await store.getPipelineConfig(configId);
      if (!storedPipeline) throw new RuntimeEntityNotFoundError("pipeline-config", configId);
      const pipeline = normalizePipelineConfig(storedPipeline);
      const [execution, evaluation] = await Promise.all([
        resolveExecutionConfig(pipeline.executionConfigId),
        resolveEvaluationConfig(pipeline.evaluationConfigId),
      ]);
      return { pipeline, execution, evaluation } satisfies ResolvedPipelineConfig;
    },
  };
}

function normalizeRetryPolicy(policy: RetryPolicy | undefined): RetryPolicy {
  return policy === undefined
    ? { ...DEFAULT_RETRY_POLICY }
    : { ...policy };
}

function cloneHarnessConfig(harness: HarnessConfig): HarnessConfig {
  return {
    kind: "sp",
    framework: harness.framework,
    agentConfig: { ...harness.agentConfig },
    ...(harness.runtime === undefined ? {} : { runtime: { ...harness.runtime } }),
  };
}
