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

import type { HarnessConfig, JsonValue, RetryPolicy, SpHarnessConfig } from "@eval-platform/eval-contracts";
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

function defaultConfigIdFactory(): string {
  return crypto.randomUUID();
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRetryPolicy(
  policy: RetryPolicy | undefined,
): void {
  if (policy === undefined) return;
  if (!isObjectRecord(policy)) {
    throw new Error("retryPolicy must be an object");
  }
  if (!Number.isInteger(policy.maxRestarts) || policy.maxRestarts < 0) {
    throw new Error("retryPolicy.maxRestarts must be a non-negative integer");
  }
  if (!Number.isFinite(policy.initialBackoffMs) || policy.initialBackoffMs < 0) {
    throw new Error("retryPolicy.initialBackoffMs must be non-negative");
  }
  if (!Number.isFinite(policy.maxBackoffMs) || policy.maxBackoffMs < policy.initialBackoffMs) {
    throw new Error("retryPolicy.maxBackoffMs must be at least initialBackoffMs");
  }
}

function validateHarnessConfig(
  harness: HarnessConfig,
  field: string,
): void {
  if (!isObjectRecord(harness)) {
    throw new Error(`${field} must be an object`);
  }
  if (harness.kind === "sp") {
    if (
      harness.framework !== "sp"
      && harness.framework !== "codex"
      && harness.framework !== "cc"
    ) {
      throw new Error(`${field}.framework must be sp, codex or cc`);
    }
    if (!isObjectRecord(harness.agentConfig)) {
      throw new Error(`${field}.agentConfig must be an object`);
    }
    requireNonEmpty(harness.agentConfig.ownerUserId, `${field}.agentConfig.ownerUserId`);
    requireNonEmpty(harness.agentConfig.userAgentId, `${field}.agentConfig.userAgentId`);
    if (harness.runtime !== undefined) {
      if (!isObjectRecord(harness.runtime)) {
        throw new Error(`${field}.runtime must be an object`);
      }
      if ("workspaceMode" in harness.runtime) {
        throw new Error(`${field}.runtime.workspaceMode is no longer supported`);
      }
    }
    if (harness.runtime?.timeoutMs !== undefined) {
      if (!Number.isFinite(harness.runtime.timeoutMs) || harness.runtime.timeoutMs < 1) {
        throw new Error(`${field}.runtime.timeoutMs must be a positive number`);
      }
    }
    return;
  }

  if (harness.kind === "remote") {
    requireNonEmpty(harness.provider, `${field}.provider`);
    requireNonEmpty(harness.agentRef, `${field}.agentRef`);
    if (harness.runOptions !== undefined && !isObjectRecord(harness.runOptions)) {
      throw new Error(`${field}.runOptions must be an object`);
    }
    return;
  }

  throw new Error(`${field}.kind is not supported`);
}

function normalizeExecutionConfig(config: ExecutionConfig): ResolvedExecutionConfig {
  if (!isObjectRecord(config)) throw new Error("config must be an object");
  requireNonEmpty(config.configId, "configId");
  requireNonEmpty(config.datasetId, "datasetId");
  if (config.sampleIds !== undefined) {
    if (!Array.isArray(config.sampleIds)) throw new Error("sampleIds must be an array");
    if (config.sampleIds.length === 0) throw new Error("sampleIds must not be empty");
    config.sampleIds.forEach((sampleId, index) => {
      requireNonEmpty(sampleId, `sampleIds[${index}]`);
    });
    if (new Set(config.sampleIds).size !== config.sampleIds.length) {
      throw new Error("sampleIds must not contain duplicate ids");
    }
  }
  requirePositiveInteger(config.samplingCount, "samplingCount");
  requirePositiveInteger(config.executionConcurrency, "executionConcurrency");
  validateHarnessConfig(config.harness, "harness");
  validateRetryPolicy(config.retryPolicy);
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
  if (!isObjectRecord(config)) throw new Error("config must be an object");
  requireNonEmpty(config.configId, "configId");
  requirePositiveInteger(config.evaluationConcurrency, "evaluationConcurrency");
  validateHarnessConfig(config.evaluationHarness, "evaluationHarness");
  if (config.evaluationHarness.kind !== "sp" || config.evaluationHarness.framework !== "sp") {
    throw new Error("evaluationHarness must use the SP host and framework");
  }
  validateRetryPolicy(config.retryPolicy);
  return {
    configId: config.configId,
    evaluationHarness: {
      ...cloneSpHarnessConfig(config.evaluationHarness),
      framework: config.evaluationHarness.framework,
    },
    evaluationConcurrency: config.evaluationConcurrency,
    retryPolicy: normalizeRetryPolicy(config.retryPolicy),
  } satisfies ResolvedEvaluationConfig;
}

function normalizePipelineConfig(config: PipelineConfig): PipelineConfig {
  if (!isObjectRecord(config)) throw new Error("config must be an object");
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
  idFactory: ConfigIdFactory = defaultConfigIdFactory,
): ResolvedExecutionConfig {
  return normalizeExecutionConfig({ configId: idFactory(), ...input });
}

export function createEvaluationConfig(
  input: EvaluationConfigInput,
  idFactory: ConfigIdFactory = defaultConfigIdFactory,
): ResolvedEvaluationConfig {
  return normalizeEvaluationConfig({ configId: idFactory(), ...input });
}

export function createPipelineConfig(
  input: PipelineConfigInput,
  idFactory: ConfigIdFactory = defaultConfigIdFactory,
): PipelineConfig {
  return normalizePipelineConfig({ configId: idFactory(), ...input });
}

export function createConfigResolver(store: ConfigStore): ConfigResolver {
  async function resolveExecutionConfig(configId: string): Promise<ResolvedExecutionConfig> {
    requireNonEmpty(configId, "executionConfigId");
    const config = await store.getExecutionConfig(configId);
    if (!config) throw new Error(`Unknown execution config ${configId}`);
    return normalizeExecutionConfig(config);
  }

  async function resolveEvaluationConfig(configId: string): Promise<ResolvedEvaluationConfig> {
    requireNonEmpty(configId, "evaluationConfigId");
    const config = await store.getEvaluationConfig(configId);
    if (!config) throw new Error(`Unknown evaluation config ${configId}`);
    return normalizeEvaluationConfig(config);
  }

  return {
    resolveExecutionConfig,
    resolveEvaluationConfig,
    async resolvePipelineConfig(configId) {
      requireNonEmpty(configId, "pipelineConfigId");
      const storedPipeline = await store.getPipelineConfig(configId);
      if (!storedPipeline) throw new Error(`Unknown pipeline config ${configId}`);
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
  if (harness.kind === "sp") {
    return cloneSpHarnessConfig(harness);
  }

  return {
    kind: "remote",
    provider: harness.provider,
    agentRef: harness.agentRef,
    ...(harness.runOptions === undefined
      ? {}
      : { runOptions: cloneJsonRecord(harness.runOptions) }),
  };
}

function cloneSpHarnessConfig(harness: SpHarnessConfig): SpHarnessConfig {
  return {
    kind: "sp",
    framework: harness.framework,
    agentConfig: { ...harness.agentConfig },
    ...(harness.runtime === undefined ? {} : { runtime: { ...harness.runtime } }),
  };
}

function cloneJsonRecord(
  value: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, cloneJsonValue(entryValue)]),
  );
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value !== null && typeof value === "object") {
    return cloneJsonRecord(value as Readonly<Record<string, JsonValue>>);
  }
  return value;
}
