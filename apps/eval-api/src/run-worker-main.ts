import { Pool } from "pg";
import { startWorkerWithSignals } from "./run-worker-lifecycle.js";
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
  const origin = requiredEnv("EVAL_SP_ORIGIN");
  const serviceToken = requiredEnv("EVAL_SP_SERVICE_TOKEN");
  const pool = new Pool({ connectionString: databaseUrl });
  await startWorkerWithSignals({
    signals: process,
    start: () => startSpEvalRunWorkerProcess({
      pool,
      databaseUrl,
      sp: { origin, serviceToken },
      ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
      ...(scanIntervalMs === undefined ? {} : { scanIntervalMs }),
    }),
    closeDatabase: () => pool.end(),
    onError(error) {
      console.error(error);
      process.exitCode = 1;
    },
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
