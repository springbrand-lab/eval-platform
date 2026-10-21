import path from "node:path";
import { Pool } from "pg";
import { createEvalDb, type EvalDb } from "./client.js";
import { migrateDatabase } from "./migrations.js";

/** A temporary database using production migration and current-schema validation by default. */
export async function createTestDatabase(
  url: string,
  initialize: (db: EvalDb) => Promise<void> = (db) => migrateDatabase(db, { migrationsFolder: path.resolve("migrations-postgres") }),
): Promise<{
  readonly db: EvalDb;
  readonly connectionString: string;
  destroy(): Promise<void>;
}> {
  const databaseName = `eval_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = async (statement: string) => {
    const pool = new Pool({ connectionString: adminUrl.toString() });
    try {
      await pool.query(statement);
    } finally {
      await pool.end();
    }
  };
  await admin(`CREATE DATABASE "${databaseName}"`);
  const target = new URL(url);
  target.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: target.toString() });
  const db = createEvalDb(pool);
  try {
    await initialize(db);
  } catch (error) {
    await pool.end();
    await admin(`DROP DATABASE "${databaseName}"`);
    throw error;
  }
  return {
    db,
    connectionString: target.toString(),
    async destroy() {
      await pool.end();
      await admin(`DROP DATABASE "${databaseName}"`);
    },
  };
}
