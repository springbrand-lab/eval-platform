import { errorDiagnostics } from "@springbrand/http/server";
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss, type ConstructorOptions, type DrizzleTransactionLike, type Queue } from "pg-boss";
import type { Logger } from "pino";

export const RUN_QUEUE = "eval-runs";

/**
 * One queued-or-active job per Run (`singletonKey` = Run ID): a stop request sent while the
 * Run already has a job is absorbed by it. Heartbeats detect a crashed Worker; expiry is the
 * pg-boss maximum so a long Run is not cut short. Retries back off while a Run stays active.
 */
export const RUN_QUEUE_OPTIONS = {
  policy: "exclusive",
  notify: true,
  heartbeatSeconds: 60,
  expireInSeconds: 24 * 60 * 60,
  retryLimit: 100,
  retryDelay: 10,
  retryBackoff: true,
  retryDelayMax: 10 * 60,
} as const satisfies Omit<Queue, "name">;

export interface RunJob {
  readonly runId: string;
}

export interface RunQueue {
  /** Writes the Run job through the caller's transaction, so it commits or rolls back with the Run facts. */
  enqueue(transaction: DrizzleTransactionLike, runId: string, reason?: "collection"): Promise<void>;
}

export interface RunQueueProducer extends RunQueue {
  close(): Promise<void>;
}

/** Starts pg-boss and ensures the Run queue exists; the caller owns `stop()`. */
export async function openRunBoss(
  connectionString: string,
  logger: Logger,
  options: Pick<ConstructorOptions, "supervise" | "useListenNotify"> = {},
): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schedule: false, ...options });
  boss.on("error", (error) => logger.error({ error: errorDiagnostics(error) }, "run_queue_error"));
  boss.on("warning", (warning) => logger.warn({ detail: warning.message }, "run_queue_warning"));
  try {
    await boss.start();
    await boss.createQueue(RUN_QUEUE, RUN_QUEUE_OPTIONS);
    return boss;
  } catch (error) {
    await boss.stop();
    throw error;
  }
}

export function createRunQueue(boss: Pick<PgBoss, "send">): RunQueue {
  return {
    async enqueue(transaction, runId, reason) {
      const job: RunJob = { runId };
      // A completed stage can be recovered while its previous job is still settling.
      // Give recovery its own deduplicated wake-up so that old job cannot absorb and lose it.
      await boss.send(RUN_QUEUE, job, { singletonKey: reason === "collection" ? `collection:${runId}` : runId, db: fromDrizzle(transaction, sql) });
    },
  };
}

/** Producer for processes that admit or stop Runs without consuming jobs; the Worker supervises the queue. */
export async function startRunQueue(connectionString: string, logger: Logger): Promise<RunQueueProducer> {
  const boss = await openRunBoss(connectionString, logger, { supervise: false });
  return { ...createRunQueue(boss), close: () => boss.stop() };
}
