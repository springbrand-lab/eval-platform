import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema.js";

export type EvalDb = NodePgDatabase<typeof schema> & { $client: Pool };

export function createEvalDb(pool: Pool): EvalDb {
  return drizzle(pool, { schema });
}

export function isForeignKeyFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  if ("code" in error && (error.code === "23503" || error.code === "23001")) return true;
  return "cause" in error && isForeignKeyFailure(error.cause);
}
