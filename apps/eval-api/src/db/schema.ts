import type { EvaluationRecord, RunPhases, Sampling } from "@eval-platform/eval-contracts";
import type { Data } from "@eval-platform/eval-dataset";
import type { RunConfigSnapshot } from "@eval-platform/eval-runtime";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const projects = pgTable("eval_projects", {
  projectId: text("project_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
}, (table) => [index("eval_projects_owner_idx").on(table.ownerUserId)]);

export const datasets = pgTable("eval_datasets", {
  datasetId: uuid("dataset_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
}, (table) => [
  unique("eval_datasets_owner_id_uq").on(table.ownerUserId, table.datasetId),
  index("eval_datasets_owner_idx").on(table.ownerUserId),
]);

export const data = pgTable("eval_data", {
  dataId: uuid("data_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  content: jsonb("content").$type<Omit<Data, "dataId">>().notNull(),
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
  foreignKey({ columns: [table.ownerUserId, table.dataId], foreignColumns: [data.ownerUserId, data.dataId] }).onDelete("restrict"),
  index("eval_samples_data_idx").on(table.dataId),
  index("eval_samples_owner_idx").on(table.ownerUserId),
]);

export const samplings = pgTable("eval_samplings", {
  samplingId: text("sampling_id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.projectId, { onDelete: "restrict" }),
  sampleId: text("sample_id").notNull().references(() => samples.sampleId, { onDelete: "restrict" }),
  facts: jsonb("facts").$type<Omit<Sampling, "samplingId" | "projectId" | "sampleId">>().notNull(),
}, (table) => [
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
  projectId: text("project_id").notNull().references(() => projects.projectId, { onDelete: "restrict" }),
  phases: jsonb("phases").$type<RunPhases>().notNull(),
  config: jsonb("config").$type<RunConfigSnapshot>().notNull(),
  requestId: text("request_id").unique(),
  idempotencyKey: text("idempotency_key").unique(),
  requestFingerprint: text("request_fingerprint"),
}, (table) => [
  index("eval_runs_project_idx").on(table.projectId),
  check("eval_runs_request_identity_ck", sql`(${table.requestId} IS NULL) = (${table.requestFingerprint} IS NULL)`),
  check("eval_runs_phases_ck", sql`${table.phases} IN ('["execution"]'::jsonb, '["evaluation"]'::jsonb, '["execution", "evaluation"]'::jsonb)`),
]);

export const runSamplings = pgTable("eval_run_samplings", {
  runId: text("run_id").notNull().references(() => runs.runId, { onDelete: "cascade" }),
  samplingId: text("sampling_id").notNull().references(() => samplings.samplingId, { onDelete: "restrict" }),
  position: integer("position").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.samplingId] }),
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
