import type { z } from "zod";
import {
  absolutePathSchema,
  databaseEnvSchema,
  httpOriginSchema,
  loadEnv,
  positiveIntSchema,
  requiredStringSchema,
} from "./env.js";

const workerEnvSchema = databaseEnvSchema.extend({
  EVAL_SP_AGENT_ORIGIN: httpOriginSchema,
  EVAL_SP_SERVICE_TOKEN: requiredStringSchema,
  EVAL_BUNDLE_DIR: absolutePathSchema,
  EVAL_RUN_WORKER_CONCURRENCY: positiveIntSchema.default(8),
});

export type WorkerConfig = z.output<typeof workerEnvSchema>;

export function loadWorkerConfig(environment: Record<string, string | undefined>): WorkerConfig {
  return loadEnv(workerEnvSchema, environment);
}
