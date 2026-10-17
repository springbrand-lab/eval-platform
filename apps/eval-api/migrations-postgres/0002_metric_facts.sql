ALTER TABLE "eval_evaluations" ADD COLUMN "metric_facts" jsonb;--> statement-breakpoint
ALTER TABLE "eval_samplings" ADD COLUMN "metric_facts" jsonb;
--> statement-breakpoint
CREATE FUNCTION eval_invalidate_metric_facts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.metric_facts IS NOT DISTINCT FROM OLD.metric_facts
     AND NEW.facts IS DISTINCT FROM OLD.facts THEN
    NEW.metric_facts := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER eval_samplings_metric_facts BEFORE UPDATE OF facts ON eval_samplings
FOR EACH ROW EXECUTE FUNCTION eval_invalidate_metric_facts();
--> statement-breakpoint
CREATE TRIGGER eval_evaluations_metric_facts BEFORE UPDATE OF facts ON eval_evaluations
FOR EACH ROW EXECUTE FUNCTION eval_invalidate_metric_facts();
