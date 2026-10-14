import { Pool } from "pg";
import { startSpEvalRunWorkerProcess } from "./run-worker-process.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

async function main(): Promise<void> {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const maxConcurrentRuns = positiveIntEnv("EVAL_RUN_WORKER_CONCURRENCY");
  const scanIntervalMs = positiveIntEnv("EVAL_RUN_WORKER_SCAN_MS");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const worker = await startSpEvalRunWorkerProcess({
      pool,
      databaseUrl,
      sp: {
        origin: requiredEnv("EVAL_SP_ORIGIN"),
        serviceToken: requiredEnv("EVAL_SP_SERVICE_TOKEN"),
      },
      ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
      ...(scanIntervalMs === undefined ? {} : { scanIntervalMs }),
    });
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= worker.close().finally(() => pool.end());
      return closing;
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void close().catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
      });
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
