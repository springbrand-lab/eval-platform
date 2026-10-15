import { dataSchema } from "@eval-platform/eval-dataset";
import { createEvalRunResumer } from "@eval-platform/eval-runtime";
import { errorDiagnostics } from "@springbrand/http/server";
import { and, eq, inArray } from "drizzle-orm";
import { Pool } from "pg";
import type { Logger } from "pino";
import type { WorkerConfig } from "./config/worker.js";
import { sqlBatches } from "./db/batch.js";
import { projectWithOutputSchema } from "./db/catalog.js";
import { createEvalDb } from "./db/client.js";
import { createPostgresWorkerRuntimeStore } from "./db/runtime.js";
import { data, projects, samples } from "./db/schema.js";
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
      async getProject(projectId) {
        const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId));
        return row ? projectWithOutputSchema(db, row) : null;
      },
      async getSamples(sampleIds) {
        // Only trusted, persisted Run facts reach this cross-user recovery reader.
        const byId = new Map<string, { sampleId: string; data: ReturnType<typeof dataSchema.parse> }>();
        for (const batch of sqlBatches([...new Set(sampleIds)])) {
          const rows = await db.select({
            sampleId: samples.sampleId,
            dataId: data.dataId,
            content: data.content,
          }).from(samples).innerJoin(data, and(
            eq(samples.dataId, data.dataId),
            eq(samples.ownerUserId, data.ownerUserId),
          )).where(inArray(samples.sampleId, batch));
          for (const row of rows) {
            byId.set(row.sampleId, {
              sampleId: row.sampleId,
              data: dataSchema.parse({ ...row.content, dataId: row.dataId }),
            });
          }
        }
        return sampleIds.map((sampleId) => byId.get(sampleId) ?? null);
      },
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
