import { and, ne, sql } from "drizzle-orm";
import type { EvalDb } from "./client.js";
import { ActiveProjectLimitError } from "./errors.js";
import { runActive } from "./run-records.js";
import { runs } from "./schema.js";

type Writer = Parameters<Parameters<EvalDb["transaction"]>[0]>[0];

export const ACTIVE_PROJECT_LIMIT = 3;

/** Called after locking the Project, before a write that could make its Run active. */
export async function requireActiveProjectCapacity(transaction: Writer, projectId: string): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtext('eval-platform'), hashtext('active-projects'))`);
  const others = await transaction.selectDistinct({ projectId: runs.projectId }).from(runs)
    .where(and(ne(runs.projectId, projectId), runActive(transaction))).limit(ACTIVE_PROJECT_LIMIT);
  if (others.length >= ACTIVE_PROJECT_LIMIT) throw new ActiveProjectLimitError(ACTIVE_PROJECT_LIMIT);
}
