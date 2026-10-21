import { z } from "zod";
import { absolutePathSchema, databaseEnvSchema, httpOriginSchema, loadEnv, requiredStringSchema } from "./env.js";

/** HTTP is permitted only for explicit loopback test/development endpoints, never remote dev. */
export const importOriginSchema = httpOriginSchema.refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
}, "imports require HTTPS (or a loopback test origin)");

export const agentImportEnvShape = {
  EVAL_DEV_SP_API_ORIGIN: importOriginSchema.optional(),
  EVAL_DEV_SP_EXPORT_TOKEN: requiredStringSchema.optional(),
};

export function refineAgentImportEnv(value: {
  readonly EVAL_SP_API_ORIGIN: string;
  readonly EVAL_DEV_SP_API_ORIGIN?: string | undefined;
  readonly EVAL_DEV_SP_EXPORT_TOKEN?: string | undefined;
}, context: z.RefinementCtx): void {
  if ((value.EVAL_DEV_SP_API_ORIGIN === undefined) !== (value.EVAL_DEV_SP_EXPORT_TOKEN === undefined)) {
    context.addIssue({ code: "custom", path: ["EVAL_DEV_SP_API_ORIGIN"],
      message: "EVAL_DEV_SP_API_ORIGIN and EVAL_DEV_SP_EXPORT_TOKEN must be set together" });
  }
  if (value.EVAL_DEV_SP_API_ORIGIN === value.EVAL_SP_API_ORIGIN) {
    context.addIssue({ code: "custom", path: ["EVAL_DEV_SP_API_ORIGIN"],
      message: "source and target SP origins must be different" });
  }
}

const workerSchema = databaseEnvSchema.extend({
  EVAL_SP_API_ORIGIN: importOriginSchema,
  EVAL_SP_SERVICE_USER_ID: z.uuid().transform((value) => value.toLowerCase()),
  EVAL_SP_SERVICE_SESSION_TOKEN: requiredStringSchema,
  EVAL_WEB_ORIGIN: httpOriginSchema,
  EVAL_BUNDLE_DIR: absolutePathSchema,
  ...agentImportEnvShape,
}).superRefine(refineAgentImportEnv);

/** Separate process: no Run Worker token, admin token, Langfuse credentials or SP Agent access. */
export function loadAgentImportWorkerConfig(environment: Record<string, string | undefined>) {
  return loadEnv(workerSchema, environment);
}
export type AgentImportWorkerConfig = ReturnType<typeof loadAgentImportWorkerConfig>;
