import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { databaseEnvSchema, loadEnv } from "./config/env.js";

/** Apply `migrations-postgres` to `DATABASE_URL`; deployments run this before replacing the API and Run Worker. */
const { DATABASE_URL } = loadEnv(databaseEnvSchema, process.env);
const pool = new Pool({ connectionString: DATABASE_URL });
try {
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../migrations-postgres", import.meta.url)),
  });
  console.log("Eval database migrations applied");
} finally {
  await pool.end();
}
