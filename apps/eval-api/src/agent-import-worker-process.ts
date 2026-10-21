import { Pool } from "pg";
import type { JobWithMetadata } from "pg-boss";
import type { Logger } from "pino";
import { createAgentConfigService } from "./agent-configs.js";
import { AGENT_IMPORT_QUEUE, createAgentImportQueue, openAgentImportBoss, type AgentImportJob } from "./agent-import-queue.js";
import { openImportStaging } from "./agent-imports/bytes.js";
import { createAgentImportSource } from "./agent-imports/source.js";
import { createAgentImportTarget } from "./agent-imports/target.js";
import { createAgentImportWorker } from "./agent-imports/worker.js";
import { ImportLeaseLostError } from "./agent-imports/errors.js";
import type { AgentImportWorkerConfig } from "./config/agent-imports.js";
import { createPostgresAgentImportStore } from "./db/agent-imports.js";
import { createPostgresResourceSourceStore } from "./db/agent-import-sources.js";
import { createPostgresAgentPurposeStore } from "./db/agent-purposes.js";
import { createEvalDb } from "./db/client.js";
import { createPostgresProjectStore } from "./db/project-store.js";
import { errorDiagnostics } from "./lib/api-errors.js";
import { createEvalSpClient } from "./sp/client.js";

/** Independently startable import consumer. No Run resumer, Agent Worker token or dev writes. */
export async function startAgentImportWorkerProcess(config: AgentImportWorkerConfig, logger: Logger) {
  if (config.EVAL_DEV_SP_API_ORIGIN === undefined || config.EVAL_DEV_SP_EXPORT_TOKEN === undefined) {
    return { enabled: false, close: async () => {} };
  }
  const sp = createEvalSpClient({ origin: config.EVAL_SP_API_ORIGIN, writeOrigin: config.EVAL_WEB_ORIGIN });
  const user = await sp.verifySession(config.EVAL_SP_SERVICE_SESSION_TOKEN);
  if (user?.id !== config.EVAL_SP_SERVICE_USER_ID) throw new Error("Import target session does not belong to the fixed Eval service account");
  const source = createAgentImportSource({ origin: config.EVAL_DEV_SP_API_ORIGIN, targetOrigin: config.EVAL_SP_API_ORIGIN, token: config.EVAL_DEV_SP_EXPORT_TOKEN });
  const target = createAgentImportTarget({ origin: config.EVAL_SP_API_ORIGIN, sourceOrigin: source.origin,
    writeOrigin: config.EVAL_WEB_ORIGIN, sessionToken: config.EVAL_SP_SERVICE_SESSION_TOKEN, ownerUserId: user.id, sp });
  const staging = await openImportStaging(config.EVAL_BUNDLE_DIR);
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const boss = await openAgentImportBoss(config.DATABASE_URL, logger, true);
  try {
    const db = createEvalDb(pool);
    const queue = createAgentImportQueue(boss);
    const store = createPostgresAgentImportStore(db, user.id, queue);
    const agents = createAgentConfigService({
      ownerUserId: user.id, sessionToken: config.EVAL_SP_SERVICE_SESSION_TOKEN, sp,
      projects: createPostgresProjectStore(db, user.id), purposes: createPostgresAgentPurposeStore(db, user.id),
      sources: createPostgresResourceSourceStore(db, user.id), imports: target,
    });
    const worker = createAgentImportWorker({ source, target, store, agents, staging });
    await boss.work(AGENT_IMPORT_QUEUE, { batchSize: 1, localConcurrency: 1, includeMetadata: true },
      async (jobs: JobWithMetadata<AgentImportJob>[]) => {
        for (const job of jobs) {
          logger.info({ taskId: job.data.taskId, jobId: job.id, retryCount: job.retryCount }, "agent_import_job_start");
          try { await worker.run(job.data.taskId, { final: job.retryCount >= job.retryLimit }); }
          catch (error) {
            if (error instanceof ImportLeaseLostError) {
              // Waiting behind a healthy owner/task lease is scheduling, not a failed import attempt.
              await db.transaction((transaction) => queue.deferLease(transaction, job.data.taskId, job.id));
              logger.info({ taskId: job.data.taskId }, "agent_import_lease_deferred");
              continue;
            }
            logger.warn({ taskId: job.data.taskId, error: errorDiagnostics(error) }, "agent_import_job_retry");
            throw error;
          }
        }
      });
    let closing: Promise<void> | undefined;
    return { enabled: true, close() {
      closing ??= (async () => { await boss.offWork(AGENT_IMPORT_QUEUE, { wait: true }); await boss.stop(); await pool.end(); })();
      return closing;
    } };
  } catch (error) { await boss.stop(); await pool.end(); throw error; }
}
