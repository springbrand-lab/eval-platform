CREATE TABLE "eval_dashboard_projects" (
	"owner_user_id" text NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "eval_dashboard_projects_dashboard_id_project_id_pk" PRIMARY KEY("dashboard_id","project_id"),
	CONSTRAINT "eval_dashboard_projects_position_uq" UNIQUE("dashboard_id","position"),
	CONSTRAINT "eval_dashboard_projects_position_ck" CHECK ("eval_dashboard_projects"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "eval_dashboards" (
	"dashboard_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"creation_key" text NOT NULL,
	"creation_fingerprint" text NOT NULL,
	CONSTRAINT "eval_dashboards_owner_id_uq" UNIQUE("owner_user_id","dashboard_id"),
	CONSTRAINT "eval_dashboards_owner_creation_key_uq" UNIQUE("owner_user_id","creation_key"),
	CONSTRAINT "eval_dashboards_name_ck" CHECK (length(trim("eval_dashboards"."name")) > 0 AND length("eval_dashboards"."name") <= 120),
	CONSTRAINT "eval_dashboards_description_ck" CHECK (length("eval_dashboards"."description") <= 2000),
	CONSTRAINT "eval_dashboards_revision_ck" CHECK ("eval_dashboards"."revision" > 0 AND "eval_dashboards"."revision" <= 9007199254740991),
	CONSTRAINT "eval_dashboards_creation_ck" CHECK (length("eval_dashboards"."creation_key") > 0 AND length("eval_dashboards"."creation_fingerprint") > 0)
);
--> statement-breakpoint
ALTER TABLE "eval_dashboard_projects" ADD CONSTRAINT "eval_dashboard_projects_dashboard_fk" FOREIGN KEY ("owner_user_id","dashboard_id") REFERENCES "public"."eval_dashboards"("owner_user_id","dashboard_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_dashboard_projects" ADD CONSTRAINT "eval_dashboard_projects_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."eval_projects"("owner_user_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_dashboard_projects_project_idx" ON "eval_dashboard_projects" USING btree ("owner_user_id","project_id");--> statement-breakpoint
CREATE INDEX "eval_dashboards_owner_updated_idx" ON "eval_dashboards" USING btree ("owner_user_id","updated_at" DESC NULLS LAST,"dashboard_id");