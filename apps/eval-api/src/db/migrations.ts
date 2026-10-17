import { is, sql } from "drizzle-orm";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgTable } from "drizzle-orm/pg-core";
import type { EvalDb } from "./client.js";
import { backfillMetricFacts } from "./metric-facts.js";
import * as schema from "./schema.js";

function historyMismatch(): Error {
  return new Error("Eval database migration history does not match the checked-in SQL. Review the target database and prepare an explicit reset or data migration; no automatic reset was performed.");
}

/** Drizzle skips already dated entries without checking their hashes, so validate its recorded prefix first. */
async function assertRecordedMigrations(db: EvalDb, expected: readonly MigrationMeta[]): Promise<number> {
  const relation = await db.execute<{ name: string | null }>(sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`);
  if (relation.rows[0]?.name === null) return 0;
  const applied = await db.execute<{ hash: string; created_at: string }>(sql`
    SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id
  `);
  for (const [index, recorded] of applied.rows.entries()) {
    const migration = expected[index];
    if (!migration || Number(recorded.created_at) !== migration.folderMillis || recorded.hash !== migration.hash) {
      throw historyMismatch();
    }
  }
  return applied.rows.length;
}

/** The migration entry shared by the local command, deployment image and database tests. */
export async function migrateDatabase(db: EvalDb, config: { readonly migrationsFolder: string }): Promise<void> {
  const expected = readMigrationFiles(config);
  await assertRecordedMigrations(db, expected);
  await migrate(db, config);
  if (await assertRecordedMigrations(db, expected) !== expected.length) throw historyMismatch();
  await backfillMetricFacts(db);
  // Use the application's only table/column definition, without reading any business rows.
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await db.select().from(value).limit(0);
  }
}
