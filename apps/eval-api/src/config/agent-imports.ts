import { z } from "zod";
import { absolutePathSchema, databaseEnvSchema, httpOriginSchema, loadEnv, requiredStringSchema } from "./env.js";

const DEV_SP_API_ORIGIN = "https://devrapi.springbrand.ai";

/** HTTP is permitted only for explicit loopback test/development endpoints, never remote dev. */
export const importOriginSchema = httpOriginSchema.refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
}, "imports require HTTPS (or a loopback test origin)");

export const agentImportEnvShape = {
  SP_PLATFORM_RESOURCE_ADMIN_TOKEN: requiredStringSchema.optional(),
};

export function refineAgentImportEnv(value: {
  readonly EVAL_SP_API_ORIGIN: string;
  readonly SP_PLATFORM_RESOURCE_ADMIN_TOKEN?: string | undefined;
}, context: z.RefinementCtx): void {
  if (value.SP_PLATFORM_RESOURCE_ADMIN_TOKEN !== undefined && value.EVAL_SP_API_ORIGIN === DEV_SP_API_ORIGIN) {
    context.addIssue({ code: "custom", path: ["EVAL_SP_API_ORIGIN"],
      message: "source and target SP origins must be different" });
  }
}

export function withFixedAgentImportSource<T extends { readonly SP_PLATFORM_RESOURCE_ADMIN_TOKEN?: string | undefined }>(value: T) {
  return {
    ...value,
    ...(value.SP_PLATFORM_RESOURCE_ADMIN_TOKEN === undefined ? {} : { EVAL_DEV_SP_API_ORIGIN: DEV_SP_API_ORIGIN }),
  };
}

const workerSchema = databaseEnvSchema.extend({
  EVAL_SP_API_ORIGIN: importOriginSchema,
  EVAL_SP_SERVICE_USER_ID: z.uuid().transform((value) => value.toLowerCase()),
  EVAL_SP_SERVICE_SESSION_TOKEN: requiredStringSchema,
  EVAL_WEB_ORIGIN: httpOriginSchema,
  EVAL_BUNDLE_DIR: absolutePathSchema,
  ...agentImportEnvShape,
}).superRefine(refineAgentImportEnv).transform(withFixedAgentImportSource);

/** Source management credential only: no target admin, Run Worker, Langfuse or Agent credentials. */
export function loadAgentImportWorkerConfig(environment: Record<string, string | undefined>) {
  return loadEnv(workerSchema, environment);
}
export type AgentImportWorkerConfig = ReturnType<typeof loadAgentImportWorkerConfig>;
