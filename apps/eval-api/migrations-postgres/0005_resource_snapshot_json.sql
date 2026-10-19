ALTER TABLE "eval_attempt_resources"
	ALTER COLUMN "snapshot" SET DATA TYPE json USING "snapshot"::json,
	ALTER COLUMN "metric_snapshot" SET DATA TYPE json USING "metric_snapshot"::json;