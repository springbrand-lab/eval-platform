import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss, type DrizzleTransactionLike, type Queue } from "pg-boss";
import type { Logger } from "pino";
import { errorDiagnostics } from "./lib/api-errors.js";
import { ImportDependencyError } from "./agent-imports/errors.js";

export const AGENT_IMPORT_QUEUE = "eval-agent-imports";
export const AGENT_IMPORT_QUEUE_OPTIONS = {
  policy: "exclusive", heartbeatSeconds: 60, expireInSeconds: 24 * 60 * 60,
  retryLimit: 10, retryDelay: 10, retryBackoff: true, retryDelayMax: 10 * 60, notify: true,
} as const satisfies Omit<Queue, "name">;
export interface AgentImportJob { taskId: string }
export type AgentImportPhase = "preview" | "apply";
export interface AgentImportQueue {
  enqueue(transaction: DrizzleTransactionLike, taskId: string, phase: AgentImportPhase): Promise<void>;
}
export interface AgentImportWorkerQueue extends AgentImportQueue {
  deferLease(transaction: DrizzleTransactionLike, taskId: string, jobId: string): Promise<void>;
}
export function createAgentImportQueue(boss: Pick<PgBoss, "send" | "complete" | "upsert">): AgentImportWorkerQueue {
  return { async enqueue(transaction, taskId, phase) {
    // Ready can commit before the preview delivery is ACKed. Its active key must not absorb apply.
    const id = await boss.send(AGENT_IMPORT_QUEUE, { taskId } satisfies AgentImportJob, {
      singletonKey: `${phase}:${taskId}`, db: fromDrizzle(transaction, sql),
    });
    if (id === null) throw new ImportDependencyError("Agent import wake-up could not be scheduled; retry the same request");
  }, async deferLease(transaction, taskId, jobId) {
    const db = fromDrizzle(transaction, sql);
    await boss.complete(AGENT_IMPORT_QUEUE, jobId, null, { db });
    const next = await boss.upsert(AGENT_IMPORT_QUEUE, { taskId } satisfies AgentImportJob, {
      singletonKey: `lease:${taskId}`, startAfter: new Date(Date.now() + 15_000), db,
    });
    if (next.jobs.length === 0) throw new ImportDependencyError("Agent import lease wake-up could not be scheduled; retry the same task");
  } };
}
export async function openAgentImportBoss(connectionString: string, logger: Logger, supervise = false) {
  const boss = new PgBoss({ connectionString, schedule: false, supervise });
  boss.on("error", (error) => logger.error({ error: errorDiagnostics(error) }, "agent_import_queue_error"));
  boss.on("warning", (warning) => logger.warn({ detail: warning.message }, "agent_import_queue_warning"));
  try {
    await boss.start();
    await boss.createQueue(AGENT_IMPORT_QUEUE, AGENT_IMPORT_QUEUE_OPTIONS);
    return boss;
  } catch (error) { await boss.stop(); throw error; }
}
