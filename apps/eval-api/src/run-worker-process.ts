import { createEvalRunResumer } from "@eval-platform/eval-runtime";
import type { Pool } from "pg";
import { readProject, readSamples } from "./db/catalog.js";
import { createEvalDb } from "./db/client.js";
import { createPostgresWorkerRuntimeStore } from "./db/runtime.js";
import { createSpHarness, type SpHarnessOptions } from "./sp/harness.js";
import { createPostgresRunNotifications, startEvalRunWorker, type EvalRunWorker } from "./worker.js";

export interface SpEvalRunWorkerProcessOptions {
  readonly pool: Pool;
  readonly databaseUrl: string;
  readonly sp: SpHarnessOptions;
  readonly maxConcurrentRuns?: number;
  readonly scanIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly onError?: (error: Error) => void;
}

/** Runs admitted, persisted Runs. Admission and Config editing belong to the API process. */
export async function startSpEvalRunWorkerProcess(options: SpEvalRunWorkerProcessOptions): Promise<EvalRunWorker> {
  const db = createEvalDb(options.pool);
  const store = createPostgresWorkerRuntimeStore(db);
  const runtime = createEvalRunResumer({
    // Only trusted, persisted Run facts reach these cross-user recovery readers.
    getProject: (projectId) => readProject(db, projectId),
    getSamples: (sampleIds) => readSamples(db, sampleIds),
    harness: createSpHarness(options.sp),
    store,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  return startEvalRunWorker({
    runtime,
    store,
    notifications: createPostgresRunNotifications(options.databaseUrl),
    ...(options.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: options.maxConcurrentRuns }),
    ...(options.scanIntervalMs === undefined ? {} : { scanIntervalMs: options.scanIntervalMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
}
