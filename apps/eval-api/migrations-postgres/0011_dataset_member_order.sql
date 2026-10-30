ALTER TABLE "eval_dataset_data" ADD COLUMN "position" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_dataset_data_position_uq" ON "eval_dataset_data" USING btree ("dataset_id","position");--> statement-breakpoint
ALTER TABLE "eval_dataset_data" ADD CONSTRAINT "eval_dataset_data_position_ck" CHECK ("eval_dataset_data"."position" IS NULL OR "eval_dataset_data"."position" >= 0);