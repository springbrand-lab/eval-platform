CREATE TABLE "eval_agent_import_intents" (
	"owner_user_id" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"source_connection_id" text NOT NULL,
	"source_user_id" text NOT NULL,
	"source_digest" text NOT NULL,
	"applied_target_digest" text NOT NULL,
	"import_key" text NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"resource" json NOT NULL,
	"status" text NOT NULL,
	"receipt" json,
	"attachment" json,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_agent_import_intents_owner_user_id_resource_kind_resource_id_pk" PRIMARY KEY("owner_user_id","resource_kind","resource_id"),
	CONSTRAINT "eval_agent_import_intents_key_uq" UNIQUE("owner_user_id","import_key"),
	CONSTRAINT "eval_agent_import_intents_kind_ck" CHECK ("eval_agent_import_intents"."resource_kind" IN ('agent', 'skill', 'reference')),
	CONSTRAINT "eval_agent_import_intents_status_ck" CHECK ("eval_agent_import_intents"."status" IN ('planned', 'submitting', 'confirmed', 'completed', 'conflict', 'outcome_unknown')),
	CONSTRAINT "eval_agent_import_intents_receipt_ck" CHECK ("eval_agent_import_intents"."status" NOT IN ('confirmed', 'completed') OR "eval_agent_import_intents"."receipt" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "eval_agent_import_leases" (
	"owner_user_id" text PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"token" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_agent_import_task_intents" (
	"owner_user_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	CONSTRAINT "eval_agent_import_task_intents_task_id_resource_kind_resource_id_pk" PRIMARY KEY("task_id","resource_kind","resource_id")
);
--> statement-breakpoint
CREATE TABLE "eval_agent_import_tasks" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"actor_id" text,
	"source_connection_id" text NOT NULL,
	"source_user_id" text NOT NULL,
	"request_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"request" json NOT NULL,
	"status" text NOT NULL,
	"view" json NOT NULL,
	"snapshot" json,
	"plan" json,
	"apply_key" text,
	"apply_fingerprint" text,
	"expires_at" timestamp with time zone NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_agent_import_tasks_owner_id_uq" UNIQUE("owner_user_id","task_id"),
	CONSTRAINT "eval_agent_import_tasks_request_uq" UNIQUE("owner_user_id","request_key"),
	CONSTRAINT "eval_agent_import_tasks_identity_ck" CHECK (length("eval_agent_import_tasks"."owner_user_id") > 0 AND length("eval_agent_import_tasks"."request_key") > 0 AND length("eval_agent_import_tasks"."request_fingerprint") > 0),
	CONSTRAINT "eval_agent_import_tasks_status_ck" CHECK ("eval_agent_import_tasks"."status" IN (
    'checking', 'ready', 'queued', 'importing', 'completed', 'completed_with_errors', 'failed', 'outcome_unknown')),
	CONSTRAINT "eval_agent_import_tasks_apply_ck" CHECK (("eval_agent_import_tasks"."apply_key" IS NULL) = ("eval_agent_import_tasks"."apply_fingerprint" IS NULL)),
	CONSTRAINT "eval_agent_import_tasks_lease_ck" CHECK (("eval_agent_import_tasks"."lease_token" IS NULL) = ("eval_agent_import_tasks"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "eval_resource_sources" (
	"owner_user_id" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"origin" text NOT NULL,
	"source_connection_id" text,
	"source_user_id" text,
	"source_digest" text,
	"applied_target_digest" text,
	"receipt" json,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_resource_sources_owner_user_id_resource_kind_resource_id_pk" PRIMARY KEY("owner_user_id","resource_kind","resource_id"),
	CONSTRAINT "eval_resource_sources_kind_ck" CHECK ("eval_resource_sources"."resource_kind" IN ('agent', 'skill', 'reference')),
	CONSTRAINT "eval_resource_sources_origin_ck" CHECK ("eval_resource_sources"."origin" IN ('eval_native', 'dev_import', 'platform_catalog')),
	CONSTRAINT "eval_resource_sources_identity_ck" CHECK (length("eval_resource_sources"."owner_user_id") > 0 AND length("eval_resource_sources"."resource_id") BETWEEN 1 AND 255),
	CONSTRAINT "eval_resource_sources_proof_ck" CHECK ("eval_resource_sources"."origin" = 'eval_native' OR (
    "eval_resource_sources"."source_connection_id" IS NOT NULL AND "eval_resource_sources"."source_user_id" IS NOT NULL
    AND "eval_resource_sources"."source_digest" IS NOT NULL AND "eval_resource_sources"."applied_target_digest" IS NOT NULL
    AND ("eval_resource_sources"."origin" = 'platform_catalog' OR "eval_resource_sources"."receipt" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "eval_agent_import_leases" ADD CONSTRAINT "eval_agent_import_leases_owner_user_id_task_id_eval_agent_import_tasks_owner_user_id_task_id_fk" FOREIGN KEY ("owner_user_id","task_id") REFERENCES "public"."eval_agent_import_tasks"("owner_user_id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_agent_import_task_intents" ADD CONSTRAINT "eval_agent_import_task_intents_owner_user_id_task_id_eval_agent_import_tasks_owner_user_id_task_id_fk" FOREIGN KEY ("owner_user_id","task_id") REFERENCES "public"."eval_agent_import_tasks"("owner_user_id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_agent_import_task_intents" ADD CONSTRAINT "eval_agent_import_task_intents_owner_user_id_resource_kind_resource_id_eval_agent_import_intents_owner_user_id_resource_kind_resource_id_fk" FOREIGN KEY ("owner_user_id","resource_kind","resource_id") REFERENCES "public"."eval_agent_import_intents"("owner_user_id","resource_kind","resource_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_agent_import_tasks_owner_idx" ON "eval_agent_import_tasks" USING btree ("owner_user_id");