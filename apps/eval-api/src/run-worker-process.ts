import { DEFAULT_EVIDENCE_LIMITS } from "@eval-platform/eval-contracts";
import { createEvalRunResumer, type RuntimeLog } from "@eval-platform/eval-runtime";
import { createEvaluationScoreReader } from "@eval-platform/eval-metrics";
import { errorDiagnostics } from "@springbrand/http/server";
import { Pool } from "pg";
import type { Logger } from "pino";
import type { WorkerConfig } from "./config/worker.js";
import { createEvalDb } from "./db/client.js";
import { createPostgresEvaluationSubmissions } from "./db/evaluation-submissions.js";
import { createEvaluationResultPort } from "./evaluation-results/submission.js";
import { createPostgresWorkerProjectPlanReader } from "./db/project-plans.js";
import { createLangfuseScorePublisher } from "./langfuse/scores.js";
import { createPostgresWorkerRuntimeStore } from "./db/runtime.js";
import { createRunQueue, openRunBoss } from "./run-worker-queue.js";
import { openEvidenceStore } from "./evidence/store.js";
import { openBundleDirectory } from "./sp/bundle-directory.js";
import { createSpHarness, spEvidenceLimits } from "./sp/harness.js";
import { startEvalRunWorker } from "./worker.js";

export interface SpEvalRunWorkerProcess {
  /** Stops fetching Run jobs, waits for active Runs, then closes pg-boss and the database pool. */
  close(): Promise<void>;
}

const ERROR_EVENTS = new Set(["retry_exhausted"]);
const WARNING_EVENTS = new Set(["ws_reconnect", "operation_retry"]);

/** Runtime and Harness diagnostics as pino records named by the event; a failure or retry is a warning. */
export function eventLogger(logger: Pick<Logger, "info" | "warn" | "error">): RuntimeLog {
  return ({ name, ...fields }) => {
    const level = ERROR_EVENTS.has(name) ? "error" : fields.error !== undefined || WARNING_EVENTS.has(name) ? "warn" : "info";
    logger[level](fields, name);
  };
}

/** Runs admitted, persisted Runs from their Project plans. Admission belongs to the API process. */
export async function startSpEvalRunWorkerProcess(config: WorkerConfig, logger: Logger): Promise<SpEvalRunWorkerProcess> {
  const bundles = await openBundleDirectory(config.EVAL_BUNDLE_DIR);
  const evidence = await openEvidenceStore(config);
  const boss = await openRunBoss(config.DATABASE_URL, logger, { useListenNotify: true });
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  try {
    const log = eventLogger(logger);
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
        log,
      }),
      store,
      evidence,
      // Trajectory parts are split in Runtime, so it must use the limits SP can import.
      evidenceLimits: spEvidenceLimits(DEFAULT_EVIDENCE_LIMITS),
      ...(config.langfuse === undefined ? {} : { scores: {
        read: createEvaluationScoreReader(),
        publish: createLangfuseScorePublisher({ config: config.langfuse }),
      } }),
      results: createEvaluationResultPort({
        store: createPostgresEvaluationSubmissions(db),
        ...(config.EVAL_RESULT_MCP_TOKEN === undefined ? {} : { token: config.EVAL_RESULT_MCP_TOKEN }),
      }),
      log,
      onError: (error, context) => logger.error({ ...context, error: errorDiagnostics(error) }, "run_runtime_error"),
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
