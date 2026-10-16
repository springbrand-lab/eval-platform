CREATE TABLE "eval_evaluation_submissions" (
	"evaluation_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_evaluation_submissions" ADD CONSTRAINT "eval_evaluation_submissions_evaluation_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."eval_evaluations"("evaluation_id") ON DELETE cascade ON UPDATE no action;