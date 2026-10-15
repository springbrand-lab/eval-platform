import { z } from "zod";
import { requireEvalSpRelease, type EvalSpRelease } from "../db/release.js";
import {
  absolutePathSchema,
  databaseEnvSchema,
  httpOriginSchema,
  loadEnv,
  portSchema,
  requiredStringSchema,
} from "./env.js";

export const apiEnvSchema = databaseEnvSchema.extend({
  /** Eval SP API: session verification and Agent Config. */
  EVAL_SP_API_ORIGIN: httpOriginSchema,
  /** Eval Web: the only CORS origin and the trusted Origin of SP write requests. */
  EVAL_WEB_ORIGIN: httpOriginSchema,
  EVAL_SP_SOURCE_BRANCH: requiredStringSchema,
  EVAL_SP_SOURCE_COMMIT: requiredStringSchema,
  EVAL_BUNDLE_DIR: absolutePathSchema,
  EVAL_API_HOST: requiredStringSchema.default("127.0.0.1"),
  EVAL_API_PORT: portSchema.default(8788),
});

export type ApiConfig = Omit<z.output<typeof apiEnvSchema>, "EVAL_SP_SOURCE_BRANCH" | "EVAL_SP_SOURCE_COMMIT"> & {
  readonly release: EvalSpRelease;
};

/** Parse the API process environment once; invalid configuration stops startup. */
export function loadApiConfig(environment: Record<string, string | undefined>): ApiConfig {
  const { EVAL_SP_SOURCE_BRANCH, EVAL_SP_SOURCE_COMMIT, ...config } = loadEnv(apiEnvSchema, environment);
  return {
    ...config,
    release: requireEvalSpRelease({ sourceBranch: EVAL_SP_SOURCE_BRANCH, sourceCommit: EVAL_SP_SOURCE_COMMIT }),
  };
}
