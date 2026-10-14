CREATE TABLE "eval_data" (
	"data_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"content" jsonb NOT NULL,
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
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "eval_datasets_owner_id_uq" UNIQUE("owner_user_id","dataset_id")
);
--> statement-breakpoint
CREATE TABLE "eval_evaluation_configs" (
	"config_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"settings" jsonb NOT NULL,
	CONSTRAINT "eval_evaluation_configs_owner_id_uq" UNIQUE("owner_user_id","config_id")
);
--> statement-breakpoint
CREATE TABLE "eval_evaluations" (
	"evaluation_id" text PRIMARY KEY NOT NULL,
	"sampling_id" text NOT NULL,
	"facts" jsonb NOT NULL,
	CONSTRAINT "eval_evaluations_identity_sampling_uq" UNIQUE("evaluation_id","sampling_id")
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
	CONSTRAINT "eval_projects_owner_id_uq" UNIQUE("owner_user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "eval_run_evaluations" (
	"run_id" text NOT NULL,
	"evaluation_id" text NOT NULL,
	"sampling_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "eval_run_evaluations_run_id_evaluation_id_pk" PRIMARY KEY("run_id","evaluation_id"),
	CONSTRAINT "eval_run_evaluations_identity_uq" UNIQUE("evaluation_id"),
	CONSTRAINT "eval_run_evaluations_position_uq" UNIQUE("run_id","position")
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
	"phases" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	CONSTRAINT "eval_runs_owner_id_uq" UNIQUE("owner_user_id","run_id"),
	CONSTRAINT "eval_runs_project_idempotency_uq" UNIQUE("project_id","idempotency_key"),
	CONSTRAINT "eval_runs_phases_ck" CHECK ("eval_runs"."phases" IN ('["execution"]'::jsonb, '["evaluation"]'::jsonb, '["execution", "evaluation"]'::jsonb))
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
ALTER TABLE "eval_dataset_data" ADD CONSTRAINT "eval_dataset_data_owner_user_id_dataset_id_eval_datasets_owner_user_id_dataset_id_fk" FOREIGN KEY ("owner_user_id","dataset_id") REFERENCES "public"."eval_datasets"("owner_user_id","dataset_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_dataset_data" ADD CONSTRAINT "eval_dataset_data_owner_user_id_data_id_eval_data_owner_user_id_data_id_fk" FOREIGN KEY ("owner_user_id","data_id") REFERENCES "public"."eval_data"("owner_user_id","data_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_evaluations" ADD CONSTRAINT "eval_evaluations_sampling_id_eval_samplings_sampling_id_fk" FOREIGN KEY ("sampling_id") REFERENCES "public"."eval_samplings"("sampling_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_execution_configs" ADD CONSTRAINT "eval_execution_configs_owner_user_id_dataset_id_eval_datasets_owner_user_id_dataset_id_fk" FOREIGN KEY ("owner_user_id","dataset_id") REFERENCES "public"."eval_datasets"("owner_user_id","dataset_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_pipeline_configs" ADD CONSTRAINT "eval_pipeline_configs_owner_user_id_execution_config_id_eval_execution_configs_owner_user_id_config_id_fk" FOREIGN KEY ("owner_user_id","execution_config_id") REFERENCES "public"."eval_execution_configs"("owner_user_id","config_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_pipeline_configs" ADD CONSTRAINT "eval_pipeline_configs_owner_user_id_evaluation_config_id_eval_evaluation_configs_owner_user_id_config_id_fk" FOREIGN KEY ("owner_user_id","evaluation_config_id") REFERENCES "public"."eval_evaluation_configs"("owner_user_id","config_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_evaluations" ADD CONSTRAINT "eval_run_evaluations_run_id_eval_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_evaluations" ADD CONSTRAINT "eval_run_evaluations_run_id_sampling_id_eval_run_samplings_run_id_sampling_id_fk" FOREIGN KEY ("run_id","sampling_id") REFERENCES "public"."eval_run_samplings"("run_id","sampling_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_evaluations" ADD CONSTRAINT "eval_run_evaluations_evaluation_id_sampling_id_eval_evaluations_evaluation_id_sampling_id_fk" FOREIGN KEY ("evaluation_id","sampling_id") REFERENCES "public"."eval_evaluations"("evaluation_id","sampling_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_samplings" ADD CONSTRAINT "eval_run_samplings_owner_user_id_run_id_eval_runs_owner_user_id_run_id_fk" FOREIGN KEY ("owner_user_id","run_id") REFERENCES "public"."eval_runs"("owner_user_id","run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_samplings" ADD CONSTRAINT "eval_run_samplings_owner_user_id_sampling_id_eval_samplings_owner_user_id_sampling_id_fk" FOREIGN KEY ("owner_user_id","sampling_id") REFERENCES "public"."eval_samplings"("owner_user_id","sampling_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_owner_user_id_project_id_eval_projects_owner_user_id_project_id_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."eval_projects"("owner_user_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_samples" ADD CONSTRAINT "eval_samples_owner_user_id_data_id_eval_data_owner_user_id_data_id_fk" FOREIGN KEY ("owner_user_id","data_id") REFERENCES "public"."eval_data"("owner_user_id","data_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_samplings" ADD CONSTRAINT "eval_samplings_owner_user_id_project_id_eval_projects_owner_user_id_project_id_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."eval_projects"("owner_user_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_samplings" ADD CONSTRAINT "eval_samplings_owner_user_id_sample_id_eval_samples_owner_user_id_sample_id_fk" FOREIGN KEY ("owner_user_id","sample_id") REFERENCES "public"."eval_samples"("owner_user_id","sample_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_data_owner_idx" ON "eval_data" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_dataset_data_data_idx" ON "eval_dataset_data" USING btree ("data_id");--> statement-breakpoint
CREATE INDEX "eval_datasets_owner_idx" ON "eval_datasets" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_evaluations_sampling_idx" ON "eval_evaluations" USING btree ("sampling_id");--> statement-breakpoint
CREATE INDEX "eval_projects_owner_idx" ON "eval_projects" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_run_samplings_sampling_idx" ON "eval_run_samplings" USING btree ("sampling_id");--> statement-breakpoint
CREATE INDEX "eval_runs_project_idx" ON "eval_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "eval_samples_data_idx" ON "eval_samples" USING btree ("data_id");--> statement-breakpoint
CREATE INDEX "eval_samples_owner_idx" ON "eval_samples" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "eval_samplings_project_idx" ON "eval_samplings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "eval_samplings_sample_idx" ON "eval_samplings" USING btree ("sample_id");