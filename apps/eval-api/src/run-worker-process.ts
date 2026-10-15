import { createEvalRunResumer } from "@eval-platform/eval-runtime";
import { errorDiagnostics } from "@springbrand/http/server";
import { Pool } from "pg";
import type { Logger } from "pino";
import type { WorkerConfig } from "./config/worker.js";
import { createEvalDb } from "./db/client.js";
import { createPostgresWorkerProjectPlanReader } from "./db/project-plans.js";
import { createPostgresWorkerRuntimeStore } from "./db/runtime.js";
import { createRunQueue, openRunBoss } from "./run-worker-queue.js";
import { openBundleDirectory } from "./sp/bundle-directory.js";
import { createSpHarness } from "./sp/harness.js";
import { startEvalRunWorker } from "./worker.js";

export interface SpEvalRunWorkerProcess {
  /** Stops fetching Run jobs, waits for active Runs, then closes pg-boss and the database pool. */
  close(): Promise<void>;
}

/** Runs admitted, persisted Runs from their Project plans. Admission belongs to the API process. */
export async function startSpEvalRunWorkerProcess(config: WorkerConfig, logger: Logger): Promise<SpEvalRunWorkerProcess> {
  const bundles = await openBundleDirectory(config.EVAL_BUNDLE_DIR);
  const boss = await openRunBoss(config.DATABASE_URL, logger, { useListenNotify: true });
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  try {
    const db = createEvalDb(pool);
    const store = createPostgresWorkerRuntimeStore(db, createRunQueue(boss));
    const runtime = createEvalRunResumer({
      // Only trusted, persisted Run facts reach this cross-user plan reader.
      plans: createPostgresWorkerProjectPlanReader(db),
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
