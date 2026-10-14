import { createEvalRuntime, type ConfigResolver, type RuntimeCatalog } from "@eval-platform/eval-runtime";
import { dataSchema } from "@eval-platform/eval-dataset";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createEvalDb } from "./db/client.js";
import { createPostgresWorkerRuntimeStore } from "./db/runtime.js";
import { data, samples } from "./db/schema.js";
import { createSpHarness, type SpHarnessOptions } from "./sp/harness.js";
import { createPostgresRunNotifications, startEvalRunWorker, type EvalRunWorker } from "./worker.js";

export interface SpEvalRunWorkerProcessOptions {
  readonly pool: Pool;
  readonly databaseUrl: string;
  readonly sp: SpHarnessOptions;
  readonly maxConcurrentRuns?: number;
  readonly scanIntervalMs?: number;
  readonly onError?: (error: Error) => void;
}

/** Runs admitted, persisted Runs. Admission and Config editing belong to the API process. */
export async function startSpEvalRunWorkerProcess(options: SpEvalRunWorkerProcessOptions): Promise<EvalRunWorker> {
  const db = createEvalDb(options.pool);
  const store = createPostgresWorkerRuntimeStore(db);
  const unavailable = async (): Promise<never> => {
    throw new Error("Run admission and Config resolution belong to the Eval API process");
  };
  const configResolver: ConfigResolver = {
    resolveExecutionConfig: unavailable,
    resolveEvaluationConfig: unavailable,
    resolvePipelineConfig: unavailable,
  };
  const catalog: RuntimeCatalog = {
    listProjects: unavailable,
    listAgents: unavailable,
    listDatasets: unavailable,
    listData: unavailable,
    listSamples: unavailable,
    async getSample(sampleId) {
      // Only trusted, persisted Run facts reach this cross-user recovery reader.
      const [row] = await db.select({
        sampleId: samples.sampleId,
        dataId: data.dataId,
        content: data.content,
      }).from(samples).innerJoin(data, and(
        eq(samples.dataId, data.dataId),
        eq(samples.ownerUserId, data.ownerUserId),
      )).where(eq(samples.sampleId, sampleId));
      return row
        ? { sampleId: row.sampleId, data: dataSchema.parse({ ...row.content, dataId: row.dataId }) }
        : null;
    },
  };
  const runtime = createEvalRuntime({
    catalog,
    configResolver,
    harness: createSpHarness(options.sp),
    store,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  return startEvalRunWorker({
    runtime,
    store,
    notifications: createPostgresRunNotifications(options.databaseUrl),
    ...(options.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: options.maxConcurrentRuns }),
    ...(options.scanIntervalMs === undefined ? {} : { scanIntervalMs: options.scanIntervalMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
}
