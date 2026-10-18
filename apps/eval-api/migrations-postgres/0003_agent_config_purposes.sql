CREATE TABLE "eval_agent_config_purposes" (
	"owner_user_id" text NOT NULL,
	"user_agent_id" text NOT NULL,
	"purpose" text NOT NULL,
	"evaluation_mcp_server_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_agent_config_purposes_pk" PRIMARY KEY("owner_user_id","user_agent_id"),
	CONSTRAINT "eval_agent_config_purposes_purpose_ck" CHECK ("eval_agent_config_purposes"."purpose" IN ('execution', 'evaluation')),
	CONSTRAINT "eval_agent_config_purposes_evaluation_mcp_ck" CHECK ("eval_agent_config_purposes"."purpose" = 'execution' OR "eval_agent_config_purposes"."evaluation_mcp_server_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "eval_agent_config_purposes_owner_idx" ON "eval_agent_config_purposes" USING btree ("owner_user_id");
