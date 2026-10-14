ALTER TABLE "eval_runs" ADD COLUMN "stop_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "stop_finalized" boolean DEFAULT false NOT NULL;