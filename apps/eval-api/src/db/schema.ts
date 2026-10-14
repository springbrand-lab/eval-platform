import type { EvaluationOutputSchema, EvaluationRecord, ProjectInitialLaunch, RunPhases, Sampling } from "@eval-platform/eval-contracts";
import type { Data } from "@eval-platform/eval-dataset";
import type { EvaluationConfig, ExecutionConfig, RunConfigSnapshot } from "@eval-platform/eval-runtime";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const projects = pgTable("eval_projects", {
  projectId: text("project_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  sourceBranch: text("source_branch").notNull(),
  evaluationOutputSchemaId: uuid("evaluation_output_schema_id"),
  evaluationOutputSchemaLocked: boolean("evaluation_output_schema_locked").notNull().default(false),
  initialLaunch: jsonb("initial_launch").$type<ProjectInitialLaunch>(),
}, (table) => [
  unique("eval_projects_owner_id_uq").on(table.ownerUserId, table.projectId),
  index("eval_projects_owner_idx").on(table.ownerUserId),
  check("eval_projects_source_branch_ck", sql`length(trim(${table.sourceBranch})) > 0`),
  check("eval_projects_initial_launch_ck", sql`${table.initialLaunch} IS NULL OR coalesce((jsonb_typeof(${table.initialLaunch}) = 'object' AND ${table.initialLaunch}->>'operation' IN ('execution', 'pipeline') AND length(${table.initialLaunch}->>'configId') > 0), false)`),
  foreignKey({ columns: [table.ownerUserId, table.evaluationOutputSchemaId], foreignColumns: [evaluationOutputSchemas.ownerUserId, evaluationOutputSchemas.outputSchemaId] }).onDelete("restrict"),
]);

export const evaluationOutputSchemas = pgTable("eval_evaluation_output_schemas", {
  outputSchemaId: uuid("output_schema_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  schema: jsonb("schema").$type<EvaluationOutputSchema>().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  unique("eval_evaluation_output_schemas_owner_id_uq").on(table.ownerUserId, table.outputSchemaId),
  index("eval_evaluation_output_schemas_owner_idx").on(table.ownerUserId),
  check("eval_evaluation_output_schemas_name_ck", sql`length(trim(${table.name})) > 0`),
  check("eval_evaluation_output_schemas_description_ck", sql`length(trim(${table.description})) > 0`),
]);

export const bundles = pgTable("eval_bundles", {
  bundleId: uuid("bundle_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  unique("eval_bundles_owner_id_uq").on(table.ownerUserId, table.bundleId),
  index("eval_bundles_owner_idx").on(table.ownerUserId),
  check("eval_bundles_name_ck", sql`length(trim(${table.name})) > 0`),
  check("eval_bundles_description_ck", sql`length(trim(${table.description})) > 0`),
]);

export const bundleMaterials = pgTable("eval_bundle_materials", {
  materialId: uuid("material_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  bundleId: uuid("bundle_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  unique("eval_bundle_materials_owner_id_uq").on(table.ownerUserId, table.materialId),
  foreignKey({ columns: [table.ownerUserId, table.bundleId], foreignColumns: [bundles.ownerUserId, bundles.bundleId] }).onDelete("restrict"),
  index("eval_bundle_materials_bundle_idx").on(table.bundleId),
  check("eval_bundle_materials_name_ck", sql`length(trim(${table.name})) > 0`),
  check("eval_bundle_materials_description_ck", sql`length(trim(${table.description})) > 0`),
]);

export const bundleSessions = pgTable("eval_bundle_sessions", {
  sessionId: uuid("session_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  bundleId: uuid("bundle_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  format: text("format").$type<"json" | "jsonl">().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  unique("eval_bundle_sessions_owner_id_uq").on(table.ownerUserId, table.sessionId),
  foreignKey({ columns: [table.ownerUserId, table.bundleId], foreignColumns: [bundles.ownerUserId, bundles.bundleId] }).onDelete("restrict"),
  index("eval_bundle_sessions_bundle_idx").on(table.bundleId),
  check("eval_bundle_sessions_name_ck", sql`length(trim(${table.name})) > 0`),
  check("eval_bundle_sessions_description_ck", sql`length(trim(${table.description})) > 0`),
  check("eval_bundle_sessions_format_ck", sql`${table.format} IN ('json', 'jsonl')`),
]);

export const datasets = pgTable("eval_datasets", {
  datasetId: uuid("dataset_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  kind: text("kind").$type<"general" | "prompt">().notNull().default("general"),
  name: text("name").notNull(),
  description: text("description"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  unique("eval_datasets_owner_id_uq").on(table.ownerUserId, table.datasetId),
  index("eval_datasets_owner_idx").on(table.ownerUserId),
  check("eval_datasets_kind_ck", sql`${table.kind} IN ('general', 'prompt')`),
]);

export const executionConfigs = pgTable("eval_execution_configs", {
  configId: text("config_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  datasetId: uuid("dataset_id").notNull(),
  settings: jsonb("settings").$type<Omit<ExecutionConfig, "configId" | "datasetId">>().notNull(),
}, (table) => [
  unique("eval_execution_configs_owner_id_uq").on(table.ownerUserId, table.configId),
  foreignKey({ columns: [table.ownerUserId, table.datasetId], foreignColumns: [datasets.ownerUserId, datasets.datasetId] }).onDelete("restrict"),
]);

export const evaluationConfigs = pgTable("eval_evaluation_configs", {
  configId: text("config_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  settings: jsonb("settings").$type<Omit<EvaluationConfig, "configId">>().notNull(),
}, (table) => [
  unique("eval_evaluation_configs_owner_id_uq").on(table.ownerUserId, table.configId),
]);

export const pipelineConfigs = pgTable("eval_pipeline_configs", {
  configId: text("config_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  executionConfigId: text("execution_config_id").notNull(),
  evaluationConfigId: text("evaluation_config_id").notNull(),
}, (table) => [
  unique("eval_pipeline_configs_owner_id_uq").on(table.ownerUserId, table.configId),
  foreignKey({ columns: [table.ownerUserId, table.executionConfigId], foreignColumns: [executionConfigs.ownerUserId, executionConfigs.configId] }).onDelete("restrict"),
  foreignKey({ columns: [table.ownerUserId, table.evaluationConfigId], foreignColumns: [evaluationConfigs.ownerUserId, evaluationConfigs.configId] }).onDelete("restrict"),
]);

export const data = pgTable("eval_data", {
  dataId: uuid("data_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  content: jsonb("content").$type<Omit<Data, "dataId">>().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  unique("eval_data_owner_id_uq").on(table.ownerUserId, table.dataId),
  index("eval_data_owner_idx").on(table.ownerUserId),
]);

export const datasetData = pgTable("eval_dataset_data", {
  ownerUserId: text("owner_user_id").notNull(),
  datasetId: uuid("dataset_id").notNull(),
  dataId: uuid("data_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.datasetId, table.dataId] }),
  foreignKey({ columns: [table.ownerUserId, table.datasetId], foreignColumns: [datasets.ownerUserId, datasets.datasetId] }).onDelete("cascade"),
  foreignKey({ columns: [table.ownerUserId, table.dataId], foreignColumns: [data.ownerUserId, data.dataId] }).onDelete("restrict"),
  index("eval_dataset_data_data_idx").on(table.dataId),
]);

export const samples = pgTable("eval_samples", {
  sampleId: text("sample_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  dataId: uuid("data_id").notNull(),
}, (table) => [
  unique("eval_samples_owner_id_uq").on(table.ownerUserId, table.sampleId),
  foreignKey({ columns: [table.ownerUserId, table.dataId], foreignColumns: [data.ownerUserId, data.dataId] }).onDelete("restrict"),
  index("eval_samples_data_idx").on(table.dataId),
  index("eval_samples_owner_idx").on(table.ownerUserId),
]);

export const samplings = pgTable("eval_samplings", {
  samplingId: text("sampling_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  projectId: text("project_id").notNull(),
  sampleId: text("sample_id").notNull(),
  facts: jsonb("facts").$type<Omit<Sampling, "samplingId" | "projectId" | "sampleId">>().notNull(),
}, (table) => [
  unique("eval_samplings_owner_id_uq").on(table.ownerUserId, table.samplingId),
  foreignKey({ columns: [table.ownerUserId, table.projectId], foreignColumns: [projects.ownerUserId, projects.projectId] }).onDelete("restrict"),
  foreignKey({ columns: [table.ownerUserId, table.sampleId], foreignColumns: [samples.ownerUserId, samples.sampleId] }).onDelete("restrict"),
  index("eval_samplings_project_idx").on(table.projectId),
  index("eval_samplings_sample_idx").on(table.sampleId),
]);

export const evaluations = pgTable("eval_evaluations", {
  evaluationId: text("evaluation_id").primaryKey(),
  samplingId: text("sampling_id").notNull().references(() => samplings.samplingId, { onDelete: "restrict" }),
  facts: jsonb("facts").$type<Omit<EvaluationRecord, "evaluationId" | "samplingId">>().notNull(),
}, (table) => [
  unique("eval_evaluations_identity_sampling_uq").on(table.evaluationId, table.samplingId),
  index("eval_evaluations_sampling_idx").on(table.samplingId),
]);

export const runs = pgTable("eval_runs", {
  runId: text("run_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  projectId: text("project_id").notNull(),
  sourceCommit: text("source_commit").notNull(),
  phases: jsonb("phases").$type<RunPhases>().notNull(),
  config: jsonb("config").$type<RunConfigSnapshot>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  stopRequested: boolean("stop_requested").notNull().default(false),
  stopFinalized: boolean("stop_finalized").notNull().default(false),
}, (table) => [
  unique("eval_runs_owner_id_uq").on(table.ownerUserId, table.runId),
  foreignKey({ columns: [table.ownerUserId, table.projectId], foreignColumns: [projects.ownerUserId, projects.projectId] }).onDelete("restrict"),
  index("eval_runs_project_idx").on(table.projectId),
  unique("eval_runs_project_idempotency_uq").on(table.projectId, table.idempotencyKey),
  check("eval_runs_phases_ck", sql`${table.phases} IN ('["execution"]'::jsonb, '["evaluation"]'::jsonb, '["execution", "evaluation"]'::jsonb)`),
  check("eval_runs_source_commit_ck", sql`${table.sourceCommit} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`),
]);

/** Retired request identities prevent a late retry from replacing newer Project state. */
export const runRequestKeys = pgTable("eval_run_request_keys", {
  ownerUserId: text("owner_user_id").notNull(),
  projectId: text("project_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.idempotencyKey] }),
  foreignKey({ columns: [table.ownerUserId, table.projectId], foreignColumns: [projects.ownerUserId, projects.projectId] }).onDelete("cascade"),
]);

export const runSamplings = pgTable("eval_run_samplings", {
  ownerUserId: text("owner_user_id").notNull(),
  runId: text("run_id").notNull(),
  samplingId: text("sampling_id").notNull(),
  position: integer("position").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.samplingId] }),
  foreignKey({ columns: [table.ownerUserId, table.runId], foreignColumns: [runs.ownerUserId, runs.runId] }).onDelete("cascade"),
  foreignKey({ columns: [table.ownerUserId, table.samplingId], foreignColumns: [samplings.ownerUserId, samplings.samplingId] }).onDelete("restrict"),
  unique("eval_run_samplings_position_uq").on(table.runId, table.position),
  index("eval_run_samplings_sampling_idx").on(table.samplingId),
]);

export const runEvaluations = pgTable("eval_run_evaluations", {
  runId: text("run_id").notNull().references(() => runs.runId, { onDelete: "cascade" }),
  evaluationId: text("evaluation_id").notNull(),
  samplingId: text("sampling_id").notNull(),
  position: integer("position").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.evaluationId] }),
  unique("eval_run_evaluations_identity_uq").on(table.evaluationId),
  unique("eval_run_evaluations_position_uq").on(table.runId, table.position),
  foreignKey({ columns: [table.runId, table.samplingId], foreignColumns: [runSamplings.runId, runSamplings.samplingId] }),
  foreignKey({ columns: [table.evaluationId, table.samplingId], foreignColumns: [evaluations.evaluationId, evaluations.samplingId] }),
]);
