import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { databaseEnvSchema, loadEnv } from "./config/env.js";
import { createEvalDb } from "./db/client.js";
import { migrateDatabase } from "./db/migrations.js";

/** Apply `migrations-postgres` to `DATABASE_URL`; deployments run this before replacing the API and Run Worker. */
const { DATABASE_URL } = loadEnv(databaseEnvSchema, process.env);
const pool = new Pool({ connectionString: DATABASE_URL });
try {
  const db = createEvalDb(pool);
  const target = await db.execute(sql`
    SELECT current_database() AS database, current_user AS role,
      inet_server_addr()::text AS address, inet_server_port() AS port
  `);
  console.log("Eval database migration target:", JSON.stringify(target.rows[0]));
  await migrateDatabase(db, {
    migrationsFolder: fileURLToPath(new URL("../migrations-postgres", import.meta.url)),
  });
  console.log("Eval database migrations applied");
} finally {
  await pool.end();
}
