CREATE TABLE "eval_bundle_materials" (
	"material_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"bundle_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "eval_bundle_materials_owner_id_uq" UNIQUE("owner_user_id","material_id"),
	CONSTRAINT "eval_bundle_materials_name_ck" CHECK (length(trim("eval_bundle_materials"."name")) > 0),
	CONSTRAINT "eval_bundle_materials_description_ck" CHECK (length(trim("eval_bundle_materials"."description")) > 0)
);
--> statement-breakpoint
CREATE TABLE "eval_bundle_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"bundle_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"format" text NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "eval_bundle_sessions_owner_id_uq" UNIQUE("owner_user_id","session_id"),
	CONSTRAINT "eval_bundle_sessions_name_ck" CHECK (length(trim("eval_bundle_sessions"."name")) > 0),
	CONSTRAINT "eval_bundle_sessions_description_ck" CHECK (length(trim("eval_bundle_sessions"."description")) > 0),
	CONSTRAINT "eval_bundle_sessions_format_ck" CHECK ("eval_bundle_sessions"."format" IN ('json', 'jsonl'))
);
--> statement-breakpoint
CREATE TABLE "eval_bundles" (
	"bundle_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "eval_bundles_owner_id_uq" UNIQUE("owner_user_id","bundle_id"),
	CONSTRAINT "eval_bundles_name_ck" CHECK (length(trim("eval_bundles"."name")) > 0),
	CONSTRAINT "eval_bundles_description_ck" CHECK (length(trim("eval_bundles"."description")) > 0)
);
--> statement-breakpoint
CREATE TABLE "eval_data" (
	"data_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"content" jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "eval_data_owner_id_uq" UNIQUE("owner_user_id","data_id")
);
--> statement-breakpoint
CREATE TABLE "eval_dataset_data" (
	"owner_user_id" text NOT NULL,
	"dataset_id" uuid NOT NULL,
	"data_id" uuid NOT NULL,
	CONSTRAINT "eval_dataset_data_dataset_id_data_id_pk" PRIMARY KEY("dataset_id","data_id")
);
--> statement-breakpoint
CREATE TABLE "eval_datasets" (
	"dataset_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "eval_datasets_owner_id_uq" UNIQUE("owner_user_id","dataset_id"),
	CONSTRAINT "eval_datasets_kind_ck" CHECK ("eval_datasets"."kind" IN ('general', 'prompt'))
);
--> statement-breakpoint
CREATE TABLE "eval_evaluation_output_schemas" (
	"output_schema_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"schema" jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "eval_evaluation_output_schemas_owner_id_uq" UNIQUE("owner_user_id","output_schema_id"),
	CONSTRAINT "eval_evaluation_output_schemas_name_ck" CHECK (length(trim("eval_evaluation_output_schemas"."name")) > 0),
	CONSTRAINT "eval_evaluation_output_schemas_description_ck" CHECK (length(trim("eval_evaluation_output_schemas"."description")) > 0)
);
--> statement-breakpoint
CREATE TABLE "eval_evaluations" (
	"evaluation_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"sampling_id" text NOT NULL,
	"facts" jsonb NOT NULL,
	CONSTRAINT "eval_evaluations_owner_identity_uq" UNIQUE("owner_user_id","evaluation_id","sampling_id")
);
--> statement-breakpoint
CREATE TABLE "eval_project_agent_configs" (
	"user_agent_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"role" text NOT NULL,
	"source_user_agent_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "eval_project_agent_configs_role_ck" CHECK ("eval_project_agent_configs"."role" IN ('subject', 'evaluator')),
	CONSTRAINT "eval_project_agent_configs_subject_ck" CHECK ("eval_project_agent_configs"."role" = 'evaluator' OR "eval_project_agent_configs"."retired_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "eval_project_datasets" (
	"owner_user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"dataset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	CONSTRAINT "eval_project_datasets_project_id_dataset_id_pk" PRIMARY KEY("project_id","dataset_id"),
	CONSTRAINT "eval_project_datasets_position_uq" UNIQUE("project_id","position"),
	CONSTRAINT "eval_project_datasets_kind_ck" CHECK ("eval_project_datasets"."kind" IN ('general', 'prompt')),
	CONSTRAINT "eval_project_datasets_position_ck" CHECK ("eval_project_datasets"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "eval_project_evaluation_plans" (
	"project_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"plan" jsonb NOT NULL,
	"digest" text NOT NULL,
	"output_schema_id" uuid NOT NULL,
	"locked_at" timestamp with time zone,
	CONSTRAINT "eval_project_evaluation_plans_digest_ck" CHECK (length("eval_project_evaluation_plans"."digest") > 0),
	CONSTRAINT "eval_project_evaluation_plans_schema_ck" CHECK ("eval_project_evaluation_plans"."plan"->'outputSchema'->>'outputSchemaId' = "eval_project_evaluation_plans"."output_schema_id"::text)
);
--> statement-breakpoint
CREATE TABLE "eval_project_execution_plans" (
	"project_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"plan" jsonb NOT NULL,
	"digest" text NOT NULL,
	CONSTRAINT "eval_project_execution_plans_digest_ck" CHECK (length("eval_project_execution_plans"."digest") > 0)
);
--> statement-breakpoint
CREATE TABLE "eval_project_sample_datasets" (
	"owner_user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"dataset_id" uuid NOT NULL,
	"project_sample_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "eval_project_sample_datasets_project_id_dataset_id_project_sample_id_pk" PRIMARY KEY("project_id","dataset_id","project_sample_id"),
	CONSTRAINT "eval_project_sample_datasets_position_uq" UNIQUE("project_id","dataset_id","position"),
	CONSTRAINT "eval_project_sample_datasets_position_ck" CHECK ("eval_project_sample_datasets"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "eval_project_samples" (
	"project_sample_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"data_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"sampling_count" integer NOT NULL,
	CONSTRAINT "eval_project_samples_identity_uq" UNIQUE("owner_user_id","project_id","project_sample_id"),
	CONSTRAINT "eval_project_samples_data_uq" UNIQUE("project_id","data_id"),
	CONSTRAINT "eval_project_samples_sampling_count_ck" CHECK ("eval_project_samples"."sampling_count" > 0),
	CONSTRAINT "eval_project_samples_data_ck" CHECK ("eval_project_samples"."data"->>'dataId' = "eval_project_samples"."data_id"::text)
);
--> statement-breakpoint
CREATE TABLE "eval_projects" (
	"project_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source_branch" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "eval_projects_owner_id_uq" UNIQUE("owner_user_id","project_id"),
	CONSTRAINT "eval_projects_name_ck" CHECK (length(trim("eval_projects"."name")) > 0),
	CONSTRAINT "eval_projects_description_ck" CHECK ("eval_projects"."description" IS NULL OR length(trim("eval_projects"."description")) > 0),
	CONSTRAINT "eval_projects_source_branch_ck" CHECK (length(trim("eval_projects"."source_branch")) > 0)
);
--> statement-breakpoint
CREATE TABLE "eval_run_evaluations" (
	"owner_user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"evaluation_id" text NOT NULL,
	"sampling_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "eval_run_evaluations_run_id_evaluation_id_pk" PRIMARY KEY("run_id","evaluation_id"),
	CONSTRAINT "eval_run_evaluations_identity_uq" UNIQUE("evaluation_id"),
	CONSTRAINT "eval_run_evaluations_position_uq" UNIQUE("run_id","position"),
	CONSTRAINT "eval_run_evaluations_sampling_uq" UNIQUE("run_id","sampling_id")
);
--> statement-breakpoint
CREATE TABLE "eval_run_request_keys" (
	"owner_user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "eval_run_request_keys_project_id_idempotency_key_pk" PRIMARY KEY("project_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "eval_run_samplings" (
	"owner_user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"sampling_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "eval_run_samplings_run_id_sampling_id_pk" PRIMARY KEY("run_id","sampling_id"),
	CONSTRAINT "eval_run_samplings_position_uq" UNIQUE("run_id","position")
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"source_commit" text NOT NULL,
	"operation" text NOT NULL,
	"phases" jsonb NOT NULL,
	"selector" jsonb NOT NULL,
	"targets" jsonb NOT NULL,
	"execution_plan_digest" text NOT NULL,
	"evaluation_plan_digest" text,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"stop_requested" boolean DEFAULT false NOT NULL,
	"stop_finalized" boolean DEFAULT false NOT NULL,
	CONSTRAINT "eval_runs_owner_id_uq" UNIQUE("owner_user_id","run_id"),
	CONSTRAINT "eval_runs_project_sequence_uq" UNIQUE("project_id","sequence"),
	CONSTRAINT "eval_runs_project_idempotency_uq" UNIQUE("project_id","idempotency_key"),
	CONSTRAINT "eval_runs_phases_ck" CHECK (("eval_runs"."phases", "eval_runs"."operation") IN (('["execution"]'::jsonb, 'execution'), ('["evaluation"]'::jsonb, 'evaluation'), ('["execution", "evaluation"]'::jsonb, 'pipeline'))),
	CONSTRAINT "eval_runs_plan_digests_ck" CHECK (length("eval_runs"."execution_plan_digest") > 0 AND (("eval_runs"."operation" = 'execution') = ("eval_runs"."evaluation_plan_digest" IS NULL)) AND coalesce(length("eval_runs"."evaluation_plan_digest") > 0, true)),
	CONSTRAINT "eval_runs_targets_ck" CHECK (jsonb_typeof("eval_runs"."selector") = 'object' AND jsonb_typeof("eval_runs"."targets"->'projectSampleIds') = 'array' AND jsonb_typeof("eval_runs"."targets"->'samplingIds') = 'array'),
	CONSTRAINT "eval_runs_request_identity_ck" CHECK (length("eval_runs"."idempotency_key") > 0 AND length("eval_runs"."request_fingerprint") > 0),
	CONSTRAINT "eval_runs_source_commit_ck" CHECK ("eval_runs"."source_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "eval_runs_sequence_ck" CHECK ("eval_runs"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "eval_samplings" (
	"sampling_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"project_sample_id" text NOT NULL,
	"facts" jsonb NOT NULL,
	CONSTRAINT "eval_samplings_owner_id_uq" UNIQUE("owner_user_id","sampling_id")
);
--> statement-breakpoint
ALTER TABLE "eval_bundle_materials" ADD CONSTRAINT "eval_bundle_materials_bundle_fk" FOREIGN KEY ("owner_user_id","bundle_id") REFERENCES "public"."eval_bundles"("owner_user_id","bundle_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_bundle_sessions" ADD CONSTRAINT "eval_bundle_sessions_bundle_fk" FOREIGN KEY ("owner_user_id","bundle_id") REFERENCES "public"."eval_bundles"("owner_user_id","bundle_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_dataset_data" ADD CONSTRAINT "eval_dataset_data_dataset_fk" FOREIGN KEY ("owner_user_id","dataset_id") REFERENCES "public"."eval_datasets"("owner_user_id","dataset_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_dataset_data" ADD CONSTRAINT "eval_dataset_data_data_fk" FOREIGN KEY ("owner_user_id","data_id") REFERENCES "public"."eval_data"("owner_user_id","data_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_evaluations" ADD CONSTRAINT "eval_evaluations_sampling_fk" FOREIGN KEY ("owner_user_id","sampling_id") REFERENCES "public"."eval_samplings"("owner_user_id","sampling_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_project_agent_configs" ADD CONSTRAINT "eval_project_agent_configs_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."eval_projects"("owner_user_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_project_datasets" ADD CONSTRAINT "eval_project_datasets_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."eval_projects"("owner_user_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_project_evaluation_plans" ADD CONSTRAINT "eval_project_evaluation_plans_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."eval_projects"("owner_user_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_project_evaluation_plans" ADD CONSTRAINT "eval_project_evaluation_plans_output_schema_fk" FOREIGN KEY ("owner_user_id","output_schema_id") REFERENCES "public"."eval_evaluation_output_schemas"("owner_user_id","output_schema_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_project_execution_plans" ADD CONSTRAINT "eval_project_execution_plans_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."eval_projects"("owner_user_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_project_sample_datasets" ADD CONSTRAINT "eval_project_sample_datasets_dataset_fk" FOREIGN KEY ("project_id","dataset_id") REFERENCES "public"."eval_project_datasets"("project_id","dataset_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_project_sample_datasets" ADD CONSTRAINT "eval_project_sample_datasets_sample_fk" FOREIGN KEY ("owner_user_id","project_id","project_sample_id") REFERENCES "public"."eval_project_samples"("owner_user_id","project_id","project_sample_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_project_samples" ADD CONSTRAINT "eval_project_samples_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."eval_projects"("owner_user_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_evaluations" ADD CONSTRAINT "eval_run_evaluations_run_fk" FOREIGN KEY ("owner_user_id","run_id") REFERENCES "public"."eval_runs"("owner_user_id","run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_evaluations" ADD CONSTRAINT "eval_run_evaluations_membership_fk" FOREIGN KEY ("run_id","sampling_id") REFERENCES "public"."eval_run_samplings"("run_id","sampling_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_evaluations" ADD CONSTRAINT "eval_run_evaluations_evaluation_fk" FOREIGN KEY ("owner_user_id","evaluation_id","sampling_id") REFERENCES "public"."eval_evaluations"("owner_user_id","evaluation_id","sampling_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_request_keys" ADD CONSTRAINT "eval_run_request_keys_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."eval_projects"("owner_user_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_samplings" ADD CONSTRAINT "eval_run_samplings_run_fk" FOREIGN KEY ("owner_user_id","run_id") REFERENCES "public"."eval_runs"("owner_user_id","run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_samplings" ADD CONSTRAINT "eval_run_samplings_sampling_fk" FOREIGN KEY ("owner_user_id","sampling_id") REFERENCES "public"."eval_samplings"("owner_user_id","sampling_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."eval_projects"("owner_user_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_samplings" ADD CONSTRAINT "eval_samplings_project_sample_fk" FOREIGN KEY ("owner_user_id","project_id","project_sample_id") REFERENCES "public"."eval_project_samples"("owner_user_id","project_id","project_sample_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_bundle_materials_bundle_idx" ON "eval_bundle_materials" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX "eval_bundle_sessions_bundle_idx" ON "eval_bundle_sessions" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX "eval_bundles_owner_idx" ON "eval_bundles" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_data_owner_idx" ON "eval_data" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_dataset_data_data_idx" ON "eval_dataset_data" USING btree ("data_id");--> statement-breakpoint
CREATE INDEX "eval_datasets_owner_idx" ON "eval_datasets" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_evaluation_output_schemas_owner_idx" ON "eval_evaluation_output_schemas" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_evaluations_sampling_idx" ON "eval_evaluations" USING btree ("sampling_id");--> statement-breakpoint
CREATE INDEX "eval_project_agent_configs_owner_idx" ON "eval_project_agent_configs" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_project_agent_configs_current_uq" ON "eval_project_agent_configs" USING btree ("project_id","role") WHERE "eval_project_agent_configs"."retired_at" IS NULL;--> statement-breakpoint
CREATE INDEX "eval_project_sample_datasets_sample_idx" ON "eval_project_sample_datasets" USING btree ("project_sample_id");--> statement-breakpoint
CREATE INDEX "eval_projects_owner_idx" ON "eval_projects" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_run_samplings_sampling_idx" ON "eval_run_samplings" USING btree ("sampling_id");--> statement-breakpoint
CREATE INDEX "eval_samplings_project_sample_idx" ON "eval_samplings" USING btree ("project_id","project_sample_id");