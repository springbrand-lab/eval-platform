import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { DatabaseError, type Pool } from "pg";
import * as schema from "./schema.js";

export type EvalDb = NodePgDatabase<typeof schema> & { $client: Pool };

export function createEvalDb(pool: Pool): EvalDb {
  return drizzle(pool, { schema });
}

export interface ConstraintViolation {
  readonly kind: "foreign-key" | "unique" | "check";
  readonly constraint: string;
}

const violationKinds: Readonly<Record<string, ConstraintViolation["kind"]>> = {
  "23001": "foreign-key",
  "23503": "foreign-key",
  "23505": "unique",
  "23514": "check",
};

/** Reads the PostgreSQL integrity violation behind a Drizzle query error, if any. */
export function constraintViolation(error: unknown): ConstraintViolation | null {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (!(current instanceof DatabaseError) || current.code === undefined) continue;
    const kind = violationKinds[current.code];
    if (kind !== undefined) return { kind, constraint: current.constraint ?? "" };
  }
  return null;
}
