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
import { createEvaluationConfig, createExecutionConfig, createPipelineConfig } from "@eval-platform/eval-runtime";
import { and, eq, inArray } from "drizzle-orm";
import { isForeignKeyFailure, type EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { datasetData, datasets, evaluationConfigs, executionConfigs, pipelineConfigs, samples } from "./schema.js";
import { EvalSpApiError, type EvalSpClient } from "../sp/client.js";

type ConfigKind = "execution" | "evaluation" | "pipeline";

export class ConfigEntityNotFoundError extends Error {
  constructor(kind: ConfigKind, configId: string) {
    super(`Unknown ${kind} config ${configId}`);
    this.name = "ConfigEntityNotFoundError";
  }
}

export class ConfigIdentityConflictError extends Error {
  constructor(kind: ConfigKind, configId: string) {
    super(`${kind} config identity already exists: ${configId}`);
    this.name = "ConfigIdentityConflictError";
  }
}

export class ConfigReferenceError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} ${id} is outside the config owner scope or does not exist`);
    this.name = "ConfigReferenceError";
  }
}

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

export function createPostgresConfigStore(
  db: EvalDb,
  ownerUserId: string,
  sp: Pick<EvalSpClient, "getAgentConfig">,
  sessionToken: string,
): PostgresConfigStore {
  const owner = requireOwnerUserId(ownerUserId);
  if (typeof sp?.getAgentConfig !== "function") throw new TypeError("Eval SP Agent Config client is required");
  if (typeof sessionToken !== "string" || sessionToken.length === 0) throw new TypeError("Session token is required");

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

  async function requireDatasetSamples(
    reader: Pick<EvalDb, "select">,
    datasetId: string,
    sampleIds: readonly string[] | undefined,
  ): Promise<void> {
    if (sampleIds === undefined || sampleIds.length === 0) return;
    const rows = await reader.select({ sampleId: samples.sampleId }).from(samples)
      .innerJoin(datasetData, and(
        eq(datasetData.ownerUserId, samples.ownerUserId), eq(datasetData.dataId, samples.dataId),
      ))
      .where(and(eq(samples.ownerUserId, owner), eq(datasetData.datasetId, datasetId),
        inArray(samples.sampleId, sampleIds)));
    const owned = new Set(rows.map((row) => row.sampleId));
    const missing = sampleIds.find((sampleId) => !owned.has(sampleId));
    if (missing !== undefined) throw new ConfigReferenceError("Dataset Sample", missing);
  }

  async function lockDataset(reader: Pick<EvalDb, "select">, datasetId: string): Promise<void> {
    const [dataset] = await reader.select({ datasetId: datasets.datasetId }).from(datasets)
      .where(and(eq(datasets.ownerUserId, owner), eq(datasets.datasetId, datasetId))).for("share");
    if (!dataset) throw new ConfigReferenceError("Dataset", datasetId);
  }

  async function prepareExecutionConfig(input: ExecutionConfigInput, configId?: string): Promise<ExecutionConfig> {
    const config = configId === undefined ? createExecutionConfig(input) : createExecutionConfig(input, () => configId);
    if (config.harness.kind === "sp") await requireAgentOwner(config.harness.agentConfig);
    return config;
  }

  async function writeExecutionConfig(
    config: ExecutionConfig,
    write: (transaction: Pick<EvalDb, "insert" | "update">) => Promise<void>,
  ): Promise<ExecutionConfig> {
    return db.transaction(async (transaction) => {
      await lockDataset(transaction, config.datasetId);
      await requireDatasetSamples(transaction, config.datasetId, config.sampleIds);
      try {
        await write(transaction);
      } catch (error) {
        if (isForeignKeyFailure(error)) throw new ConfigReferenceError("Dataset", config.datasetId);
        throw error;
      }
      return config;
    });
  }

  async function requirePipelineReferences(config: PipelineConfig): Promise<void> {
    const [execution, evaluation] = await Promise.all([
      db.select({ configId: executionConfigs.configId }).from(executionConfigs)
        .where(and(eq(executionConfigs.ownerUserId, owner), eq(executionConfigs.configId, config.executionConfigId))),
      db.select({ configId: evaluationConfigs.configId }).from(evaluationConfigs)
        .where(and(eq(evaluationConfigs.ownerUserId, owner), eq(evaluationConfigs.configId, config.evaluationConfigId))),
    ]);
    if (execution.length === 0) throw new ConfigReferenceError("Execution Config", config.executionConfigId);
    if (evaluation.length === 0) throw new ConfigReferenceError("Evaluation Config", config.evaluationConfigId);
  }

  return {
    async createExecutionConfig(input) {
      const config = await prepareExecutionConfig(input);
      return writeExecutionConfig(config, async (transaction) => {
        const inserted = await transaction.insert(executionConfigs).values({
          configId: config.configId, ownerUserId: owner, datasetId: config.datasetId,
          settings: executionSettings(config),
        }).onConflictDoNothing().returning({ configId: executionConfigs.configId });
        if (inserted.length === 0) throw new ConfigIdentityConflictError("execution", config.configId);
      });
    },
    async updateExecutionConfig(configId, input) {
      const config = await prepareExecutionConfig(input, configId);
      return writeExecutionConfig(config, async (transaction) => {
        const updated = await transaction.update(executionConfigs).set({
          datasetId: config.datasetId, settings: executionSettings(config),
        }).where(and(eq(executionConfigs.ownerUserId, owner), eq(executionConfigs.configId, configId)))
          .returning({ configId: executionConfigs.configId });
        if (updated.length === 0) throw new ConfigEntityNotFoundError("execution", configId);
      });
    },
    async getExecutionConfig(configId) {
      const [row] = await db.select().from(executionConfigs)
        .where(and(eq(executionConfigs.ownerUserId, owner), eq(executionConfigs.configId, configId)));
      return row ? executionFromRow(row) : null;
    },
    async listExecutionConfigs() {
      const rows = await db.select().from(executionConfigs)
        .where(eq(executionConfigs.ownerUserId, owner)).orderBy(executionConfigs.configId);
      return rows.map(executionFromRow);
    },
    async createEvaluationConfig(input) {
      const config = createEvaluationConfig(input);
      await requireAgentOwner(config.evaluationHarness.agentConfig);
      const inserted = await db.insert(evaluationConfigs).values({
        configId: config.configId, ownerUserId: owner, settings: evaluationSettings(config),
      }).onConflictDoNothing().returning({ configId: evaluationConfigs.configId });
      if (inserted.length === 0) throw new ConfigIdentityConflictError("evaluation", config.configId);
      return config;
    },
    async updateEvaluationConfig(configId, input) {
      const config = createEvaluationConfig(input, () => configId);
      await requireAgentOwner(config.evaluationHarness.agentConfig);
      const updated = await db.update(evaluationConfigs).set({ settings: evaluationSettings(config) })
        .where(and(eq(evaluationConfigs.ownerUserId, owner), eq(evaluationConfigs.configId, configId)))
        .returning({ configId: evaluationConfigs.configId });
      if (updated.length === 0) throw new ConfigEntityNotFoundError("evaluation", configId);
      return config;
    },
    async getEvaluationConfig(configId) {
      const [row] = await db.select().from(evaluationConfigs)
        .where(and(eq(evaluationConfigs.ownerUserId, owner), eq(evaluationConfigs.configId, configId)));
      return row ? evaluationFromRow(row) : null;
    },
    async listEvaluationConfigs() {
      const rows = await db.select().from(evaluationConfigs)
        .where(eq(evaluationConfigs.ownerUserId, owner)).orderBy(evaluationConfigs.configId);
      return rows.map(evaluationFromRow);
    },
    async createPipelineConfig(input) {
      const config = createPipelineConfig(input);
      await requirePipelineReferences(config);
      try {
        const inserted = await db.insert(pipelineConfigs).values({ ...config, ownerUserId: owner })
          .onConflictDoNothing().returning({ configId: pipelineConfigs.configId });
        if (inserted.length === 0) throw new ConfigIdentityConflictError("pipeline", config.configId);
      } catch (error) {
        if (isForeignKeyFailure(error)) throw new ConfigReferenceError("Pipeline Config dependency", config.configId);
        throw error;
      }
      return config;
    },
    async updatePipelineConfig(configId, input) {
      const config = createPipelineConfig(input, () => configId);
      await requirePipelineReferences(config);
      try {
        const updated = await db.update(pipelineConfigs).set({
          executionConfigId: config.executionConfigId, evaluationConfigId: config.evaluationConfigId,
        }).where(and(eq(pipelineConfigs.ownerUserId, owner), eq(pipelineConfigs.configId, configId)))
          .returning({ configId: pipelineConfigs.configId });
        if (updated.length === 0) throw new ConfigEntityNotFoundError("pipeline", configId);
      } catch (error) {
        if (isForeignKeyFailure(error)) throw new ConfigReferenceError("Pipeline Config dependency", configId);
        throw error;
      }
      return config;
    },
    async getPipelineConfig(configId) {
      const [row] = await db.select().from(pipelineConfigs)
        .where(and(eq(pipelineConfigs.ownerUserId, owner), eq(pipelineConfigs.configId, configId)));
      return row ? pipelineFromRow(row) : null;
    },
    async listPipelineConfigs() {
      const rows = await db.select().from(pipelineConfigs)
        .where(eq(pipelineConfigs.ownerUserId, owner)).orderBy(pipelineConfigs.configId);
      return rows.map(pipelineFromRow);
    },
  };
}
