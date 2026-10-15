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
CREATE TABLE "eval_evaluation_configs" (
	"config_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"settings" jsonb NOT NULL,
	CONSTRAINT "eval_evaluation_configs_owner_id_uq" UNIQUE("owner_user_id","config_id")
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
CREATE TABLE "eval_execution_configs" (
	"config_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"dataset_id" uuid NOT NULL,
	"settings" jsonb NOT NULL,
	CONSTRAINT "eval_execution_configs_owner_id_uq" UNIQUE("owner_user_id","config_id")
);
--> statement-breakpoint
CREATE TABLE "eval_pipeline_configs" (
	"config_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"execution_config_id" text NOT NULL,
	"evaluation_config_id" text NOT NULL,
	CONSTRAINT "eval_pipeline_configs_owner_id_uq" UNIQUE("owner_user_id","config_id")
);
--> statement-breakpoint
CREATE TABLE "eval_projects" (
	"project_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"source_branch" text NOT NULL,
	"evaluation_output_schema_id" uuid,
	"evaluation_output_schema_locked" boolean DEFAULT false NOT NULL,
	"initial_launch" jsonb,
	CONSTRAINT "eval_projects_owner_id_uq" UNIQUE("owner_user_id","project_id"),
	CONSTRAINT "eval_projects_name_ck" CHECK (length(trim("eval_projects"."name")) > 0),
	CONSTRAINT "eval_projects_source_branch_ck" CHECK (length(trim("eval_projects"."source_branch")) > 0),
	CONSTRAINT "eval_projects_initial_launch_ck" CHECK ("eval_projects"."initial_launch" IS NULL OR coalesce((jsonb_typeof("eval_projects"."initial_launch") = 'object' AND "eval_projects"."initial_launch"->>'operation' IN ('execution', 'pipeline') AND length("eval_projects"."initial_launch"->>'configId') > 0), false))
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
	"source_commit" text NOT NULL,
	"phases" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"stop_requested" boolean DEFAULT false NOT NULL,
	"stop_finalized" boolean DEFAULT false NOT NULL,
	CONSTRAINT "eval_runs_owner_id_uq" UNIQUE("owner_user_id","run_id"),
	CONSTRAINT "eval_runs_project_idempotency_uq" UNIQUE("project_id","idempotency_key"),
	CONSTRAINT "eval_runs_phases_ck" CHECK (("eval_runs"."phases", "eval_runs"."config"->>'operation') IN (('["execution"]'::jsonb, 'execution'), ('["evaluation"]'::jsonb, 'evaluation'), ('["execution", "evaluation"]'::jsonb, 'pipeline'))),
	CONSTRAINT "eval_runs_request_identity_ck" CHECK (length("eval_runs"."idempotency_key") > 0 AND length("eval_runs"."request_fingerprint") > 0),
	CONSTRAINT "eval_runs_source_commit_ck" CHECK ("eval_runs"."source_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$')
);
--> statement-breakpoint
CREATE TABLE "eval_samples" (
	"sample_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"data_id" uuid NOT NULL,
	CONSTRAINT "eval_samples_owner_id_uq" UNIQUE("owner_user_id","sample_id")
);
--> statement-breakpoint
CREATE TABLE "eval_samplings" (
	"sampling_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sample_id" text NOT NULL,
	"facts" jsonb NOT NULL,
	CONSTRAINT "eval_samplings_owner_id_uq" UNIQUE("owner_user_id","sampling_id")
);
--> statement-breakpoint
ALTER TABLE "eval_bundle_materials" ADD CONSTRAINT "eval_bundle_materials_bundle_fk" FOREIGN KEY ("owner_user_id","bundle_id") REFERENCES "public"."eval_bundles"("owner_user_id","bundle_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_bundle_sessions" ADD CONSTRAINT "eval_bundle_sessions_bundle_fk" FOREIGN KEY ("owner_user_id","bundle_id") REFERENCES "public"."eval_bundles"("owner_user_id","bundle_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_dataset_data" ADD CONSTRAINT "eval_dataset_data_dataset_fk" FOREIGN KEY ("owner_user_id","dataset_id") REFERENCES "public"."eval_datasets"("owner_user_id","dataset_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_dataset_data" ADD CONSTRAINT "eval_dataset_data_data_fk" FOREIGN KEY ("owner_user_id","data_id") REFERENCES "public"."eval_data"("owner_user_id","data_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_evaluations" ADD CONSTRAINT "eval_evaluations_sampling_fk" FOREIGN KEY ("owner_user_id","sampling_id") REFERENCES "public"."eval_samplings"("owner_user_id","sampling_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_execution_configs" ADD CONSTRAINT "eval_execution_configs_dataset_fk" FOREIGN KEY ("owner_user_id","dataset_id") REFERENCES "public"."eval_datasets"("owner_user_id","dataset_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_pipeline_configs" ADD CONSTRAINT "eval_pipeline_configs_execution_config_fk" FOREIGN KEY ("owner_user_id","execution_config_id") REFERENCES "public"."eval_execution_configs"("owner_user_id","config_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_pipeline_configs" ADD CONSTRAINT "eval_pipeline_configs_evaluation_config_fk" FOREIGN KEY ("owner_user_id","evaluation_config_id") REFERENCES "public"."eval_evaluation_configs"("owner_user_id","config_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_projects" ADD CONSTRAINT "eval_projects_output_schema_fk" FOREIGN KEY ("owner_user_id","evaluation_output_schema_id") REFERENCES "public"."eval_evaluation_output_schemas"("owner_user_id","output_schema_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_evaluations" ADD CONSTRAINT "eval_run_evaluations_run_fk" FOREIGN KEY ("owner_user_id","run_id") REFERENCES "public"."eval_runs"("owner_user_id","run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_evaluations" ADD CONSTRAINT "eval_run_evaluations_membership_fk" FOREIGN KEY ("run_id","sampling_id") REFERENCES "public"."eval_run_samplings"("run_id","sampling_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_evaluations" ADD CONSTRAINT "eval_run_evaluations_evaluation_fk" FOREIGN KEY ("owner_user_id","evaluation_id","sampling_id") REFERENCES "public"."eval_evaluations"("owner_user_id","evaluation_id","sampling_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_request_keys" ADD CONSTRAINT "eval_run_request_keys_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."eval_projects"("owner_user_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_samplings" ADD CONSTRAINT "eval_run_samplings_run_fk" FOREIGN KEY ("owner_user_id","run_id") REFERENCES "public"."eval_runs"("owner_user_id","run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_samplings" ADD CONSTRAINT "eval_run_samplings_sampling_fk" FOREIGN KEY ("owner_user_id","sampling_id") REFERENCES "public"."eval_samplings"("owner_user_id","sampling_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."eval_projects"("owner_user_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_samples" ADD CONSTRAINT "eval_samples_data_fk" FOREIGN KEY ("owner_user_id","data_id") REFERENCES "public"."eval_data"("owner_user_id","data_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_samplings" ADD CONSTRAINT "eval_samplings_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."eval_projects"("owner_user_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_samplings" ADD CONSTRAINT "eval_samplings_sample_fk" FOREIGN KEY ("owner_user_id","sample_id") REFERENCES "public"."eval_samples"("owner_user_id","sample_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_bundle_materials_bundle_idx" ON "eval_bundle_materials" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX "eval_bundle_sessions_bundle_idx" ON "eval_bundle_sessions" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX "eval_bundles_owner_idx" ON "eval_bundles" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_data_owner_idx" ON "eval_data" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_dataset_data_data_idx" ON "eval_dataset_data" USING btree ("data_id");--> statement-breakpoint
CREATE INDEX "eval_datasets_owner_idx" ON "eval_datasets" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_evaluation_output_schemas_owner_idx" ON "eval_evaluation_output_schemas" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_evaluations_sampling_idx" ON "eval_evaluations" USING btree ("sampling_id");--> statement-breakpoint
CREATE INDEX "eval_projects_owner_idx" ON "eval_projects" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_run_samplings_sampling_idx" ON "eval_run_samplings" USING btree ("sampling_id");--> statement-breakpoint
CREATE INDEX "eval_runs_project_idx" ON "eval_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "eval_samples_data_idx" ON "eval_samples" USING btree ("data_id");--> statement-breakpoint
CREATE INDEX "eval_samples_owner_idx" ON "eval_samples" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_samplings_project_idx" ON "eval_samplings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "eval_samplings_sample_idx" ON "eval_samplings" USING btree ("sample_id");