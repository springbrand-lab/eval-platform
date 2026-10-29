import { z } from "zod";
import { requireEvalSpRelease, type EvalSpRelease } from "../db/release.js";
import { agentImportEnvShape, refineAgentImportEnv, withFixedAgentImportSource } from "./agent-imports.js";
import {
  absolutePathSchema,
  databaseEnvSchema,
  httpOriginSchema,
  langfuseEnvShape,
  loadEnv,
  portSchema,
  refineLangfuseEnv,
  requiredStringSchema,
  takeLangfuseConfig,
} from "./env.js";

const apiEnvSchema = databaseEnvSchema.extend({
  /** Eval SP API: service session verification and Agent Config. */
  EVAL_SP_API_ORIGIN: httpOriginSchema,
  /** The fixed Eval SP service account that owns every Eval record. */
  EVAL_SP_SERVICE_USER_ID: z.uuid().transform((value) => value.toLowerCase()),
  /** Long-lived session of that account, issued by SP's eval:bootstrap-service-account. */
  EVAL_SP_SERVICE_SESSION_TOKEN: requiredStringSchema,
  /** The Eval SP deployment's own RESOURCE_ADMIN_TOKEN, used only to grant the service account credits. */
  EVAL_SP_ADMIN_TOKEN: requiredStringSchema,
  /** Eval Web: the only CORS origin and the trusted Origin of SP write requests. */
  EVAL_WEB_ORIGIN: httpOriginSchema,
  EVAL_SP_SOURCE_BRANCH: requiredStringSchema,
  EVAL_SP_SOURCE_COMMIT: requiredStringSchema,
  EVAL_BUNDLE_DIR: absolutePathSchema,
  /** Eval SP Agent Worker: read-only Chat messages and Workspace for observation. */
  EVAL_SP_AGENT_ORIGIN: httpOriginSchema,
  /** An Origin Eval SP's Agent Worker trusts; observation reads are made server-side with the service session. */
  EVAL_SP_TRUSTED_ORIGIN: httpOriginSchema,
  /** Shared with the eval-web Worker. Set in every deployment; omit only for local development. */
  EVAL_WEB_API_TOKEN: z.string().min(32).optional(),
  EVAL_API_HOST: requiredStringSchema.default("127.0.0.1"),
  EVAL_API_PORT: portSchema.default(8788),
  /** Bearer token of the Evaluator result submission MCP Server; also keys every per-Evaluation submit token. */
  EVAL_RESULT_MCP_TOKEN: z.string().min(32).optional(),
  /** Bearer token for the separate Moss management MCP; never included in an Agent Config. */
  EVAL_MANAGEMENT_MCP_TOKEN: z.string().min(32).optional(),
  /** Lets the API re-sync a Run's scores; the Run Worker syncs them as Evaluations finish. */
  ...langfuseEnvShape,
  ...agentImportEnvShape,
}).superRefine(refineLangfuseEnv).superRefine(refineAgentImportEnv).superRefine((value, context) => {
  const token = value.EVAL_MANAGEMENT_MCP_TOKEN;
  if (token && [
    value.EVAL_RESULT_MCP_TOKEN, value.EVAL_WEB_API_TOKEN, value.EVAL_SP_SERVICE_SESSION_TOKEN,
    value.EVAL_SP_ADMIN_TOKEN, value.SP_PLATFORM_RESOURCE_ADMIN_TOKEN,
  ].includes(token)) {
    context.addIssue({ code: "custom", path: ["EVAL_MANAGEMENT_MCP_TOKEN"],
      message: "management MCP token must differ from every other configured credential" });
  }
}).transform(withFixedAgentImportSource);

export type ApiConfig = Omit<ReturnType<typeof takeLangfuseConfig<z.output<typeof apiEnvSchema>>>,
  "EVAL_SP_SOURCE_BRANCH" | "EVAL_SP_SOURCE_COMMIT"> & {
  readonly release: EvalSpRelease;
};

/** Parse the API process environment once; invalid configuration stops startup. */
export function loadApiConfig(environment: Record<string, string | undefined>): ApiConfig {
  const { EVAL_SP_SOURCE_BRANCH, EVAL_SP_SOURCE_COMMIT, ...config } = takeLangfuseConfig(loadEnv(apiEnvSchema, environment));
  return {
    ...config,
    release: requireEvalSpRelease({ sourceBranch: EVAL_SP_SOURCE_BRANCH, sourceCommit: EVAL_SP_SOURCE_COMMIT }),
  };
}
