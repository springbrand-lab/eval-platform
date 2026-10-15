import type { z } from "zod";
import {
  absolutePathSchema,
  databaseEnvSchema,
  httpOriginSchema,
  langfuseEnvShape,
  loadEnv,
  positiveIntSchema,
  refineLangfuseEnv,
  requiredStringSchema,
  takeLangfuseConfig,
} from "./env.js";

/** The Eval-only R2 bucket for evidence bundles; all four are set together or not at all. */
const evidenceR2EnvShape = {
  EVAL_EVIDENCE_R2_ENDPOINT: httpOriginSchema.optional(),
  EVAL_EVIDENCE_R2_BUCKET: requiredStringSchema.optional(),
  EVAL_EVIDENCE_R2_ACCESS_KEY_ID: requiredStringSchema.optional(),
  EVAL_EVIDENCE_R2_SECRET_ACCESS_KEY: requiredStringSchema.optional(),
};

const workerEnvSchema = databaseEnvSchema.extend({
  EVAL_SP_AGENT_ORIGIN: httpOriginSchema,
  EVAL_SP_SERVICE_TOKEN: requiredStringSchema,
  EVAL_BUNDLE_DIR: absolutePathSchema,
  EVAL_RUN_WORKER_CONCURRENCY: positiveIntSchema.default(8),
  ...evidenceR2EnvShape,
  ...langfuseEnvShape,
}).superRefine((value, context) => {
  refineLangfuseEnv(value, context);
  const set = Object.keys(evidenceR2EnvShape).filter((key) => value[key as keyof typeof value] !== undefined).length;
  if (set !== 0 && set !== Object.keys(evidenceR2EnvShape).length) {
    context.addIssue({
      code: "custom",
      path: ["EVAL_EVIDENCE_R2_ENDPOINT"],
      message: "EVAL_EVIDENCE_R2_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY must be set together",
    });
  }
});

type WorkerEnv = z.output<typeof workerEnvSchema>;

export type WorkerConfig = ReturnType<typeof takeLangfuseConfig<Omit<WorkerEnv, keyof typeof evidenceR2EnvShape>>> & {
  readonly evidenceR2?: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
};

export function loadWorkerConfig(environment: Record<string, string | undefined>): WorkerConfig {
  const {
    EVAL_EVIDENCE_R2_ENDPOINT: endpoint, EVAL_EVIDENCE_R2_BUCKET: bucket,
    EVAL_EVIDENCE_R2_ACCESS_KEY_ID: accessKeyId, EVAL_EVIDENCE_R2_SECRET_ACCESS_KEY: secretAccessKey, ...rest
  } = loadEnv(workerEnvSchema, environment);
  return {
    ...takeLangfuseConfig(rest),
    ...(endpoint && bucket && accessKeyId && secretAccessKey
      ? { evidenceR2: { endpoint, bucket, accessKeyId, secretAccessKey } } : {}),
  };
}
