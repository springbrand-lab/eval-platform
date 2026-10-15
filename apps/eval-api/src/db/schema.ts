import type {
  AgentConfigSnapshot,
  AgentRole,
  EvaluationOutputSchema,
  EvaluationPlan,
  EvaluationRecord,
  ExecutionPlan,
  RunOperation,
  RunPhases,
  RunTargetSelector,
  RunTargets,
  Sampling,
} from "@eval-platform/eval-contracts";
import type { Data } from "@eval-platform/eval-dataset";
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const PROJECT_CREATION_KEY_UQ = "eval_projects_creation_key_uq";

export const projects = pgTable("eval_projects", {
  projectId: text("project_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  sourceBranch: text("source_branch").notNull(),
  /** The creation request's idempotency key and the fingerprint of its validated body. */
  creationKey: text("creation_key").notNull(),
  creationFingerprint: text("creation_fingerprint").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  unique("eval_projects_owner_id_uq").on(table.ownerUserId, table.projectId),
  unique(PROJECT_CREATION_KEY_UQ).on(table.ownerUserId, table.creationKey),
  check("eval_projects_creation_ck", sql`length(${table.creationKey}) > 0 AND length(${table.creationFingerprint}) > 0`),
  index("eval_projects_owner_idx").on(table.ownerUserId),
  check("eval_projects_name_ck", sql`length(trim(${table.name})) > 0`),
  check("eval_projects_description_ck", sql`${table.description} IS NULL OR length(trim(${table.description})) > 0`),
  check("eval_projects_source_branch_ck", sql`length(trim(${table.sourceBranch})) > 0`),
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
  foreignKey({ name: "eval_bundle_materials_bundle_fk", columns: [table.ownerUserId, table.bundleId], foreignColumns: [bundles.ownerUserId, bundles.bundleId] }).onDelete("restrict"),
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
  foreignKey({ name: "eval_bundle_sessions_bundle_fk", columns: [table.ownerUserId, table.bundleId], foreignColumns: [bundles.ownerUserId, bundles.bundleId] }).onDelete("restrict"),
  index("eval_bundle_sessions_bundle_idx").on(table.bundleId),
  check("eval_bundle_sessions_name_ck", sql`length(trim(${table.name})) > 0`),
  check("eval_bundle_sessions_description_ck", sql`length(trim(${table.description})) > 0`),
  check("eval_bundle_sessions_format_ck", sql`${table.format} IN ('json', 'jsonl')`),
]);

export const datasets = pgTable("eval_datasets", {
  datasetId: uuid("dataset_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  kind: text("kind").$type<"general" | "prompt">().notNull(),
  name: text("name").notNull(),
  description: text("description"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  unique("eval_datasets_owner_id_uq").on(table.ownerUserId, table.datasetId),
  index("eval_datasets_owner_idx").on(table.ownerUserId),
  check("eval_datasets_kind_ck", sql`${table.kind} IN ('general', 'prompt')`),
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
  foreignKey({ name: "eval_dataset_data_dataset_fk", columns: [table.ownerUserId, table.datasetId], foreignColumns: [datasets.ownerUserId, datasets.datasetId] }).onDelete("cascade"),
  foreignKey({ name: "eval_dataset_data_data_fk", columns: [table.ownerUserId, table.dataId], foreignColumns: [data.ownerUserId, data.dataId] }).onDelete("restrict"),
  index("eval_dataset_data_data_idx").on(table.dataId),
]);

/** A Dataset as bound at Project creation; never a foreign key to the live catalog. */
export const projectDatasets = pgTable("eval_project_datasets", {
  ownerUserId: text("owner_user_id").notNull(),
  projectId: text("project_id").notNull(),
  datasetId: uuid("dataset_id").notNull(),
  position: integer("position").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  kind: text("kind").$type<"general" | "prompt">().notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.datasetId] }),
  unique("eval_project_datasets_position_uq").on(table.projectId, table.position),
  foreignKey({ name: "eval_project_datasets_project_fk", columns: [table.ownerUserId, table.projectId], foreignColumns: [projects.ownerUserId, projects.projectId] }),
  check("eval_project_datasets_kind_ck", sql`${table.kind} IN ('general', 'prompt')`),
  check("eval_project_datasets_position_ck", sql`${table.position} >= 0`),
]);

/** A full Data copy taken at Project creation; shared Data is one ProjectSample. */
export const projectSamples = pgTable("eval_project_samples", {
  projectSampleId: text("project_sample_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  projectId: text("project_id").notNull(),
  dataId: uuid("data_id").notNull(),
  data: jsonb("data").$type<Data>().notNull(),
  samplingCount: integer("sampling_count").notNull(),
}, (table) => [
  unique("eval_project_samples_identity_uq").on(table.ownerUserId, table.projectId, table.projectSampleId),
  unique("eval_project_samples_data_uq").on(table.projectId, table.dataId),
  foreignKey({ name: "eval_project_samples_project_fk", columns: [table.ownerUserId, table.projectId], foreignColumns: [projects.ownerUserId, projects.projectId] }),
  check("eval_project_samples_sampling_count_ck", sql`${table.samplingCount} > 0`),
  check("eval_project_samples_data_ck", sql`${table.data}->>'dataId' = ${table.dataId}::text`),
]);

/** Fixed Dataset membership of each ProjectSample, in the Dataset's member order at creation. */
export const projectSampleDatasets = pgTable("eval_project_sample_datasets", {
  ownerUserId: text("owner_user_id").notNull(),
  projectId: text("project_id").notNull(),
  datasetId: uuid("dataset_id").notNull(),
  projectSampleId: text("project_sample_id").notNull(),
  position: integer("position").notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.datasetId, table.projectSampleId] }),
  unique("eval_project_sample_datasets_position_uq").on(table.projectId, table.datasetId, table.position),
  foreignKey({ name: "eval_project_sample_datasets_dataset_fk", columns: [table.projectId, table.datasetId], foreignColumns: [projectDatasets.projectId, projectDatasets.datasetId] }),
  foreignKey({ name: "eval_project_sample_datasets_sample_fk", columns: [table.ownerUserId, table.projectId, table.projectSampleId], foreignColumns: [projectSamples.ownerUserId, projectSamples.projectId, projectSamples.projectSampleId] }),
  index("eval_project_sample_datasets_sample_idx").on(table.projectSampleId),
  check("eval_project_sample_datasets_position_ck", sql`${table.position} >= 0`),
]);

/** Written once in the creation transaction and never updated. */
export const projectExecutionPlans = pgTable("eval_project_execution_plans", {
  projectId: text("project_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  plan: jsonb("plan").$type<ExecutionPlan>().notNull(),
  digest: text("digest").notNull(),
}, (table) => [
  foreignKey({ name: "eval_project_execution_plans_project_fk", columns: [table.ownerUserId, table.projectId], foreignColumns: [projects.ownerUserId, projects.projectId] }),
  check("eval_project_execution_plans_digest_ck", sql`length(${table.digest}) > 0`),
]);

/** Replaceable as a whole until `locked_at` is set by the first evaluating Run. */
export const projectEvaluationPlans = pgTable("eval_project_evaluation_plans", {
  projectId: text("project_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  plan: jsonb("plan").$type<EvaluationPlan>().notNull(),
  digest: text("digest").notNull(),
  outputSchemaId: uuid("output_schema_id").notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
}, (table) => [
  foreignKey({ name: "eval_project_evaluation_plans_project_fk", columns: [table.ownerUserId, table.projectId], foreignColumns: [projects.ownerUserId, projects.projectId] }),
  foreignKey({ name: "eval_project_evaluation_plans_output_schema_fk", columns: [table.ownerUserId, table.outputSchemaId], foreignColumns: [evaluationOutputSchemas.ownerUserId, evaluationOutputSchemas.outputSchemaId] }).onDelete("restrict"),
  check("eval_project_evaluation_plans_digest_ck", sql`length(${table.digest}) > 0`),
  check("eval_project_evaluation_plans_schema_ck", sql`${table.plan}->'outputSchema'->>'outputSchemaId' = ${table.outputSchemaId}::text`),
]);

/** Frozen SP Agent Config copies owned by a Project; hidden from the Agent Config catalog, even once retired. */
export const projectAgentConfigs = pgTable("eval_project_agent_configs", {
  userAgentId: text("user_agent_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  projectId: text("project_id").notNull(),
  role: text("role").$type<AgentRole>().notNull(),
  sourceUserAgentId: text("source_user_agent_id").notNull(),
  snapshot: jsonb("snapshot").$type<AgentConfigSnapshot>().notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
}, (table) => [
  foreignKey({ name: "eval_project_agent_configs_project_fk", columns: [table.ownerUserId, table.projectId], foreignColumns: [projects.ownerUserId, projects.projectId] }),
  index("eval_project_agent_configs_owner_idx").on(table.ownerUserId),
  uniqueIndex("eval_project_agent_configs_current_uq").on(table.projectId, table.role).where(sql`${table.retiredAt} IS NULL`),
  check("eval_project_agent_configs_role_ck", sql`${table.role} IN ('subject', 'evaluator')`),
  check("eval_project_agent_configs_subject_ck", sql`${table.role} = 'evaluator' OR ${table.retiredAt} IS NULL`),
]);

export const samplings = pgTable("eval_samplings", {
  samplingId: text("sampling_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  projectId: text("project_id").notNull(),
  projectSampleId: text("project_sample_id").notNull(),
  facts: jsonb("facts").$type<Omit<Sampling, "samplingId" | "projectId" | "projectSampleId">>().notNull(),
}, (table) => [
  unique("eval_samplings_owner_id_uq").on(table.ownerUserId, table.samplingId),
  foreignKey({ name: "eval_samplings_project_sample_fk", columns: [table.ownerUserId, table.projectId, table.projectSampleId], foreignColumns: [projectSamples.ownerUserId, projectSamples.projectId, projectSamples.projectSampleId] }),
  index("eval_samplings_project_sample_idx").on(table.projectId, table.projectSampleId),
]);

export const evaluations = pgTable("eval_evaluations", {
  evaluationId: text("evaluation_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  samplingId: text("sampling_id").notNull(),
  facts: jsonb("facts").$type<Omit<EvaluationRecord, "evaluationId" | "samplingId">>().notNull(),
}, (table) => [
  unique("eval_evaluations_owner_identity_uq").on(table.ownerUserId, table.evaluationId, table.samplingId),
  foreignKey({ name: "eval_evaluations_sampling_fk", columns: [table.ownerUserId, table.samplingId], foreignColumns: [samplings.ownerUserId, samplings.samplingId] }).onDelete("restrict"),
  index("eval_evaluations_sampling_idx").on(table.samplingId),
]);

/** Runs are never deleted; replacement removes only the selected records and their memberships. */
export const runs = pgTable("eval_runs", {
  runId: text("run_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  projectId: text("project_id").notNull(),
  /** Admission order within the Project; only the latest Run's key may be replayed. */
  sequence: integer("sequence").notNull(),
  sourceCommit: text("source_commit").notNull(),
  operation: text("operation").$type<RunOperation>().notNull(),
  phases: jsonb("phases").$type<RunPhases>().notNull(),
  selector: jsonb("selector").$type<RunTargetSelector>().notNull(),
  targets: jsonb("targets").$type<RunTargets>().notNull(),
  executionPlanDigest: text("execution_plan_digest").notNull(),
  evaluationPlanDigest: text("evaluation_plan_digest"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  stopRequested: boolean("stop_requested").notNull().default(false),
  stopFinalized: boolean("stop_finalized").notNull().default(false),
}, (table) => [
  unique("eval_runs_owner_id_uq").on(table.ownerUserId, table.runId),
  foreignKey({ name: "eval_runs_project_fk", columns: [table.ownerUserId, table.projectId], foreignColumns: [projects.ownerUserId, projects.projectId] }),
  unique("eval_runs_project_sequence_uq").on(table.projectId, table.sequence),
  unique("eval_runs_project_idempotency_uq").on(table.projectId, table.idempotencyKey),
  check("eval_runs_phases_ck", sql`(${table.phases}, ${table.operation}) IN (('["execution"]'::jsonb, 'execution'), ('["evaluation"]'::jsonb, 'evaluation'), ('["execution", "evaluation"]'::jsonb, 'pipeline'))`),
  check("eval_runs_plan_digests_ck", sql`length(${table.executionPlanDigest}) > 0 AND ((${table.operation} = 'execution') = (${table.evaluationPlanDigest} IS NULL)) AND coalesce(length(${table.evaluationPlanDigest}) > 0, true)`),
  check("eval_runs_targets_ck", sql`jsonb_typeof(${table.selector}) = 'object' AND jsonb_typeof(${table.targets}->'projectSampleIds') = 'array' AND jsonb_typeof(${table.targets}->'samplingIds') = 'array'`),
  check("eval_runs_request_identity_ck", sql`length(${table.idempotencyKey}) > 0 AND length(${table.requestFingerprint}) > 0`),
  check("eval_runs_source_commit_ck", sql`${table.sourceCommit} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`),
  check("eval_runs_sequence_ck", sql`${table.sequence} > 0`),
]);

export const runSamplings = pgTable("eval_run_samplings", {
  ownerUserId: text("owner_user_id").notNull(),
  runId: text("run_id").notNull(),
  samplingId: text("sampling_id").notNull(),
  position: integer("position").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.samplingId] }),
  foreignKey({ name: "eval_run_samplings_run_fk", columns: [table.ownerUserId, table.runId], foreignColumns: [runs.ownerUserId, runs.runId] }).onDelete("cascade"),
  foreignKey({ name: "eval_run_samplings_sampling_fk", columns: [table.ownerUserId, table.samplingId], foreignColumns: [samplings.ownerUserId, samplings.samplingId] }).onDelete("restrict"),
  unique("eval_run_samplings_position_uq").on(table.runId, table.position),
  index("eval_run_samplings_sampling_idx").on(table.samplingId),
]);

export const runEvaluations = pgTable("eval_run_evaluations", {
  ownerUserId: text("owner_user_id").notNull(),
  runId: text("run_id").notNull(),
  evaluationId: text("evaluation_id").notNull(),
  samplingId: text("sampling_id").notNull(),
  position: integer("position").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.evaluationId] }),
  unique("eval_run_evaluations_identity_uq").on(table.evaluationId),
  unique("eval_run_evaluations_position_uq").on(table.runId, table.position),
  unique("eval_run_evaluations_sampling_uq").on(table.runId, table.samplingId),
  foreignKey({ name: "eval_run_evaluations_run_fk", columns: [table.ownerUserId, table.runId], foreignColumns: [runs.ownerUserId, runs.runId] }).onDelete("cascade"),
  foreignKey({ name: "eval_run_evaluations_membership_fk", columns: [table.runId, table.samplingId], foreignColumns: [runSamplings.runId, runSamplings.samplingId] }),
  foreignKey({ name: "eval_run_evaluations_evaluation_fk", columns: [table.ownerUserId, table.evaluationId, table.samplingId], foreignColumns: [evaluations.ownerUserId, evaluations.evaluationId, evaluations.samplingId] }),
]);
