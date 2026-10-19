DROP TRIGGER "eval_samplings_metric_facts" ON "eval_samplings";--> statement-breakpoint
DROP TRIGGER "eval_evaluations_metric_facts" ON "eval_evaluations";--> statement-breakpoint
DROP FUNCTION "eval_invalidate_metric_facts"();--> statement-breakpoint
CREATE TABLE "eval_attempt_resources" (
	"stage" text NOT NULL,
	"record_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"sampling_id" text NOT NULL,
	"evaluation_id" text,
	"snapshot" jsonb NOT NULL,
	"metric_snapshot" jsonb NOT NULL,
	CONSTRAINT "eval_attempt_resources_pk" PRIMARY KEY("stage","record_id","attempt_id"),
	CONSTRAINT "eval_attempt_resources_record_ck" CHECK (("eval_attempt_resources"."stage" = 'execution' AND "eval_attempt_resources"."evaluation_id" IS NULL AND "eval_attempt_resources"."record_id" = "eval_attempt_resources"."sampling_id") OR ("eval_attempt_resources"."stage" = 'evaluation' AND "eval_attempt_resources"."record_id" = "eval_attempt_resources"."evaluation_id"))
);
--> statement-breakpoint
ALTER TABLE "eval_evaluations" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_samplings" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_attempt_resources" ADD CONSTRAINT "eval_attempt_resources_sampling_fk" FOREIGN KEY ("owner_user_id","sampling_id") REFERENCES "public"."eval_samplings"("owner_user_id","sampling_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_attempt_resources" ADD CONSTRAINT "eval_attempt_resources_evaluation_fk" FOREIGN KEY ("owner_user_id","evaluation_id","sampling_id") REFERENCES "public"."eval_evaluations"("owner_user_id","evaluation_id","sampling_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_attempt_resources_sampling_idx" ON "eval_attempt_resources" USING btree ("sampling_id");--> statement-breakpoint
ALTER TABLE "eval_evaluations" DROP COLUMN "metric_facts";--> statement-breakpoint
ALTER TABLE "eval_samplings" DROP COLUMN "metric_facts";
