import { createEvalRunResumer } from "@eval-platform/eval-runtime";
import { errorDiagnostics } from "@springbrand/http/server";
import { Pool } from "pg";
import type { Logger } from "pino";
import type { WorkerConfig } from "./config/worker.js";
import { readEvaluationOutputSchema, readSamples } from "./db/catalog.js";
import { createEvalDb } from "./db/client.js";
import { createPostgresWorkerRuntimeStore } from "./db/runtime.js";
import { createRunQueue, openRunBoss } from "./run-worker-queue.js";
import { openBundleDirectory } from "./sp/bundle-directory.js";
import { createSpHarness } from "./sp/harness.js";
import { startEvalRunWorker } from "./worker.js";

export interface SpEvalRunWorkerProcess {
  /** Stops fetching Run jobs, waits for active Runs, then closes pg-boss and the database pool. */
  close(): Promise<void>;
}

/** Runs admitted, persisted Runs. Admission and Config editing belong to the API process. */
export async function startSpEvalRunWorkerProcess(config: WorkerConfig, logger: Logger): Promise<SpEvalRunWorkerProcess> {
  const bundles = await openBundleDirectory(config.EVAL_BUNDLE_DIR);
  const boss = await openRunBoss(config.DATABASE_URL, logger, { useListenNotify: true });
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  try {
    const db = createEvalDb(pool);
    const store = createPostgresWorkerRuntimeStore(db, createRunQueue(boss));
    const runtime = createEvalRunResumer({
      // Only trusted, persisted Run facts reach these cross-user recovery readers.
      getEvaluationOutputSchema: (projectId) => readEvaluationOutputSchema(db, projectId),
      getSamples: (sampleIds) => readSamples(db, sampleIds),
      harness: createSpHarness({
        origin: config.EVAL_SP_AGENT_ORIGIN,
        serviceToken: config.EVAL_SP_SERVICE_TOKEN,
        resolveInitialMaterials: bundles.resolveInitialMaterials,
        resolveInitialSession: bundles.resolveInitialSession,
      }),
      store,
      onError: (error) => logger.error({ error: errorDiagnostics(error) }, "run_runtime_error"),
    });
    const worker = await startEvalRunWorker({
      boss, runtime, store, logger, concurrency: config.EVAL_RUN_WORKER_CONCURRENCY,
    });
    let closing: Promise<void> | undefined;
    return {
      close() {
        closing ??= (async () => {
          await worker.close();
          await boss.stop();
          await pool.end();
        })();
        return closing;
      },
    };
  } catch (error) {
    await boss.stop();
    await pool.end();
    throw error;
  }
}
