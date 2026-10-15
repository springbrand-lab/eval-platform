import type { AgentConfigRef } from "@eval-platform/eval-contracts";
import type {
  ConfigStore,
  EvaluationConfig,
  EvaluationConfigInput,
  ExecutionConfig,
  ExecutionConfigInput,
  PipelineConfig,
  PipelineConfigInput,
} from "@eval-platform/eval-runtime";
import { createEvaluationConfig, createExecutionConfig, createPipelineConfig, RuntimeEntityNotFoundError } from "@eval-platform/eval-runtime";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { EvalSpApiError, type EvalSpClient } from "../sp/client.js";
import { constraintViolation, type EvalDb } from "./client.js";
import { ConfigReferenceError } from "./errors.js";
import { requireOwnerUserId } from "./owner.js";
import {
  datasetData,
  datasets,
  evaluationConfigs,
  executionConfigs,
  PIPELINE_EVALUATION_CONFIG_FK,
  PIPELINE_EXECUTION_CONFIG_FK,
  pipelineConfigs,
  samples,
} from "./schema.js";

export interface PostgresConfigStore extends ConfigStore {
  createExecutionConfig(input: ExecutionConfigInput): Promise<ExecutionConfig>;
  updateExecutionConfig(configId: string, input: ExecutionConfigInput): Promise<ExecutionConfig>;
  listExecutionConfigs(): Promise<readonly ExecutionConfig[]>;
  createEvaluationConfig(input: EvaluationConfigInput): Promise<EvaluationConfig>;
  updateEvaluationConfig(configId: string, input: EvaluationConfigInput): Promise<EvaluationConfig>;
  listEvaluationConfigs(): Promise<readonly EvaluationConfig[]>;
  createPipelineConfig(input: PipelineConfigInput): Promise<PipelineConfig>;
  updatePipelineConfig(configId: string, input: PipelineConfigInput): Promise<PipelineConfig>;
  listPipelineConfigs(): Promise<readonly PipelineConfig[]>;
}

function executionFromRow(row: typeof executionConfigs.$inferSelect): ExecutionConfig {
  return { configId: row.configId, datasetId: row.datasetId, ...structuredClone(row.settings) };
}

function evaluationFromRow(row: typeof evaluationConfigs.$inferSelect): EvaluationConfig {
  return { configId: row.configId, ...structuredClone(row.settings) };
}

function pipelineFromRow(row: typeof pipelineConfigs.$inferSelect): PipelineConfig {
  return {
    configId: row.configId,
    executionConfigId: row.executionConfigId,
    evaluationConfigId: row.evaluationConfigId,
  };
}

function executionSettings(config: ExecutionConfig): typeof executionConfigs.$inferInsert.settings {
  const { configId: _configId, datasetId: _datasetId, ...settings } = config;
  return settings;
}

function evaluationSettings(config: EvaluationConfig): typeof evaluationConfigs.$inferInsert.settings {
  const { configId: _configId, ...settings } = config;
  return settings;
}

/** Runtime admission reads current owner-scoped config without retaining a caller's session token. */
export function createPostgresConfigReader(db: EvalDb, ownerUserId: string): ConfigStore {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    async getExecutionConfig(configId) {
      const [row] = await db.select().from(executionConfigs)
        .where(and(eq(executionConfigs.ownerUserId, owner), eq(executionConfigs.configId, configId)));
      return row ? executionFromRow(row) : null;
    },
    async getEvaluationConfig(configId) {
      const [row] = await db.select().from(evaluationConfigs)
        .where(and(eq(evaluationConfigs.ownerUserId, owner), eq(evaluationConfigs.configId, configId)));
      return row ? evaluationFromRow(row) : null;
    },
    async getPipelineConfig(configId) {
      const [row] = await db.select().from(pipelineConfigs)
        .where(and(eq(pipelineConfigs.ownerUserId, owner), eq(pipelineConfigs.configId, configId)));
      return row ? pipelineFromRow(row) : null;
    },
  };
}

export function createPostgresConfigStore(
  db: EvalDb,
  ownerUserId: string,
  sp: Pick<EvalSpClient, "getAgentConfig">,
  sessionToken: string,
): PostgresConfigStore {
  const owner = requireOwnerUserId(ownerUserId);
  const reader = createPostgresConfigReader(db, owner);

  async function requireAgentOwner(reference: AgentConfigRef): Promise<void> {
    if (reference.ownerUserId !== owner) throw new ConfigReferenceError("Agent Config", reference.userAgentId);
    try {
      const agent = await sp.getAgentConfig(sessionToken, reference.userAgentId);
      if (agent.id !== reference.userAgentId || agent.user_id !== owner) {
        throw new ConfigReferenceError("Agent Config", reference.userAgentId);
      }
    } catch (error) {
      if (error instanceof EvalSpApiError && (error.status === 403 || error.status === 404)) {
        throw new ConfigReferenceError("Agent Config", reference.userAgentId);
      }
      throw error;
    }
  }

  /** Soft-deleted Datasets still satisfy the foreign key, so the save locks the active row instead. */
  async function lockDatasetSamples(
    transaction: Pick<EvalDb, "select">,
    datasetId: string,
    sampleIds: readonly string[] | undefined,
  ): Promise<void> {
    const [dataset] = await transaction.select({ datasetId: datasets.datasetId }).from(datasets)
      .where(and(eq(datasets.ownerUserId, owner), eq(datasets.datasetId, datasetId),
        isNull(datasets.deletedAt))).for("share");
    if (!dataset) throw new ConfigReferenceError("Dataset", datasetId);
    if (sampleIds === undefined || sampleIds.length === 0) return;
    const rows = await transaction.select({ sampleId: samples.sampleId }).from(samples)
      .innerJoin(datasetData, and(
        eq(datasetData.ownerUserId, samples.ownerUserId), eq(datasetData.dataId, samples.dataId),
      ))
      .where(and(eq(samples.ownerUserId, owner), eq(datasetData.datasetId, datasetId),
        inArray(samples.sampleId, sampleIds)));
    const owned = new Set(rows.map((row) => row.sampleId));
    const missing = sampleIds.find((sampleId) => !owned.has(sampleId));
    if (missing !== undefined) throw new ConfigReferenceError("Dataset Sample", missing);
  }

  async function saveExecutionConfig(input: ExecutionConfigInput, configId?: string): Promise<ExecutionConfig> {
    const config = configId === undefined ? createExecutionConfig(input) : createExecutionConfig(input, () => configId);
    if (config.harness.kind === "sp") await requireAgentOwner(config.harness.agentConfig);
    const row = { datasetId: config.datasetId, settings: executionSettings(config) };
    return db.transaction(async (transaction) => {
      await lockDatasetSamples(transaction, config.datasetId, config.sampleIds);
      if (configId === undefined) {
        await transaction.insert(executionConfigs).values({ ...row, configId: config.configId, ownerUserId: owner });
      } else {
        const updated = await transaction.update(executionConfigs).set(row)
          .where(and(eq(executionConfigs.ownerUserId, owner), eq(executionConfigs.configId, configId)))
          .returning({ configId: executionConfigs.configId });
        if (updated.length === 0) throw new RuntimeEntityNotFoundError("execution-config", configId);
      }
      return config;
    });
  }

  async function saveEvaluationConfig(input: EvaluationConfigInput, configId?: string): Promise<EvaluationConfig> {
    const config = configId === undefined ? createEvaluationConfig(input) : createEvaluationConfig(input, () => configId);
    await requireAgentOwner(config.evaluationHarness.agentConfig);
    const settings = evaluationSettings(config);
    if (configId === undefined) {
      await db.insert(evaluationConfigs).values({ configId: config.configId, ownerUserId: owner, settings });
      return config;
    }
    const updated = await db.update(evaluationConfigs).set({ settings })
      .where(and(eq(evaluationConfigs.ownerUserId, owner), eq(evaluationConfigs.configId, configId)))
      .returning({ configId: evaluationConfigs.configId });
    if (updated.length === 0) throw new RuntimeEntityNotFoundError("evaluation-config", configId);
    return config;
  }

  /** The composite foreign keys are the only reference check; their violations name the missing config. */
  async function savePipelineConfig(input: PipelineConfigInput, configId?: string): Promise<PipelineConfig> {
    const config = configId === undefined ? createPipelineConfig(input) : createPipelineConfig(input, () => configId);
    const references = { executionConfigId: config.executionConfigId, evaluationConfigId: config.evaluationConfigId };
    try {
      if (configId === undefined) {
        await db.insert(pipelineConfigs).values({ ...references, configId: config.configId, ownerUserId: owner });
        return config;
      }
      const updated = await db.update(pipelineConfigs).set(references)
        .where(and(eq(pipelineConfigs.ownerUserId, owner), eq(pipelineConfigs.configId, configId)))
        .returning({ configId: pipelineConfigs.configId });
      if (updated.length === 0) throw new RuntimeEntityNotFoundError("pipeline-config", configId);
      return config;
    } catch (error) {
      const violation = constraintViolation(error);
      if (violation?.constraint === PIPELINE_EXECUTION_CONFIG_FK) {
        throw new ConfigReferenceError("Execution Config", config.executionConfigId);
      }
      if (violation?.constraint === PIPELINE_EVALUATION_CONFIG_FK) {
        throw new ConfigReferenceError("Evaluation Config", config.evaluationConfigId);
      }
      throw error;
    }
  }

  return {
    ...reader,
    createExecutionConfig: (input) => saveExecutionConfig(input),
    updateExecutionConfig: (configId, input) => saveExecutionConfig(input, configId),
    async listExecutionConfigs() {
      const rows = await db.select().from(executionConfigs)
        .where(eq(executionConfigs.ownerUserId, owner)).orderBy(executionConfigs.configId);
      return rows.map(executionFromRow);
    },
    createEvaluationConfig: (input) => saveEvaluationConfig(input),
    updateEvaluationConfig: (configId, input) => saveEvaluationConfig(input, configId),
    async listEvaluationConfigs() {
      const rows = await db.select().from(evaluationConfigs)
        .where(eq(evaluationConfigs.ownerUserId, owner)).orderBy(evaluationConfigs.configId);
      return rows.map(evaluationFromRow);
    },
    createPipelineConfig: (input) => savePipelineConfig(input),
    updatePipelineConfig: (configId, input) => savePipelineConfig(input, configId),
    async listPipelineConfigs() {
      const rows = await db.select().from(pipelineConfigs)
        .where(eq(pipelineConfigs.ownerUserId, owner)).orderBy(pipelineConfigs.configId);
      return rows.map(pipelineFromRow);
    },
  };
}
