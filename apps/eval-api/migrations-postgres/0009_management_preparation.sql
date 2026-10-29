CREATE TABLE "eval_management_uploads" (
	"upload_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" text NOT NULL,
	"claimed_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_management_uploads_owner_id_uq" UNIQUE("owner_user_id","upload_id"),
	CONSTRAINT "eval_management_uploads_kind_ck" CHECK ("eval_management_uploads"."kind" IN ('prompt', 'material', 'session', 'skill', 'reference')),
	CONSTRAINT "eval_management_uploads_status_ck" CHECK ("eval_management_uploads"."status" IN ('reserved', 'ready')),
	CONSTRAINT "eval_management_uploads_metadata_ck" CHECK (length("eval_management_uploads"."owner_user_id") > 0
		AND length("eval_management_uploads"."name") BETWEEN 1 AND 240
		AND length("eval_management_uploads"."media_type") BETWEEN 1 AND 200
		AND "eval_management_uploads"."byte_size" > 0
		AND "eval_management_uploads"."byte_size" <= 20971520
		AND "eval_management_uploads"."sha256" ~ '^[0-9a-f]{64}$'
		AND ("eval_management_uploads"."claimed_by" IS NULL
			OR length("eval_management_uploads"."claimed_by") BETWEEN 1 AND 200))
);
--> statement-breakpoint
CREATE INDEX "eval_management_uploads_expiry_idx" ON "eval_management_uploads" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE "eval_management_operations" (
	"owner_user_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"plan" jsonb NOT NULL,
	"stages" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"skill_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_management_operations_pk" PRIMARY KEY("owner_user_id","operation_key"),
	CONSTRAINT "eval_management_operations_kind_ck" CHECK ("eval_management_operations"."kind" IN ('prepare', 'skill', 'reference')),
	CONSTRAINT "eval_management_operations_status_ck" CHECK ("eval_management_operations"."status" IN ('pending', 'completed')),
	CONSTRAINT "eval_management_operations_identity_ck" CHECK (length("eval_management_operations"."owner_user_id") > 0
		AND length("eval_management_operations"."operation_key") BETWEEN 1 AND 200
		AND "eval_management_operations"."fingerprint" ~ '^[0-9a-f]{64}$'
		AND ("eval_management_operations"."kind" = 'skill') = ("eval_management_operations"."skill_name" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "eval_management_skill_pending_uq" ON "eval_management_operations" USING btree ("owner_user_id","skill_name")
	WHERE "eval_management_operations"."kind" = 'skill' AND "eval_management_operations"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX "eval_management_pending_dataset_idx" ON "eval_management_operations" USING btree
	("owner_user_id", ("eval_management_operations"."plan"->>'datasetId'))
	WHERE "eval_management_operations"."kind" = 'prepare' AND "eval_management_operations"."status" = 'pending';
