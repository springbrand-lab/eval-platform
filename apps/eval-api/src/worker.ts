import type { EvalRunResumer, RuntimeRecoveryStore } from "@eval-platform/eval-runtime";
import { errorDiagnostics } from "@springbrand/http/server";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { RUN_QUEUE, type RunJob } from "./run-worker-queue.js";

/** How often an active Run re-reads its persisted stop request, and repeats SP interrupts after one. */
export const STOP_POLL_MS = 1_000;

export interface RunJobHandlerOptions {
  readonly runtime: EvalRunResumer;
  readonly store: RuntimeRecoveryStore;
  readonly logger: Logger;
}

export interface EvalRunWorkerOptions extends RunJobHandlerOptions {
  readonly boss: Pick<PgBoss, "work" | "offWork">;
  readonly concurrency: number;
}

export interface EvalRunWorker {
  /** Stops fetching Run jobs and waits for the active ones to settle. */
  close(): Promise<void>;
}

/** Thrown while a Run stays active after a pass, so pg-boss retries its job with backoff. */
export class RunStillActiveError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} is still active`);
    this.name = "RunStillActiveError";
  }
}

export interface RunJobAttempt {
  /** The job has no retries left; an active Run is stopped and cleaned up instead of retried. */
  readonly final: boolean;
}

/** Processes one Run job: resume, interrupt on a persisted stop, then finalize that stop. */
export function createRunJobHandler(
  { runtime, store, logger }: RunJobHandlerOptions,
): (runId: string, attempt: RunJobAttempt) => Promise<void> {
  async function watchStop(runId: string, stop: AbortController, settled: AbortSignal): Promise<void> {
    while (!stop.signal.aborted) {
      await pause(STOP_POLL_MS, settled);
      if (settled.aborted) return;
      try {
        if (await store.isRunStopRequested(runId)) stop.abort();
      } catch (error) {
        logger.error({ runId, error: errorDiagnostics(error) }, "run_stop_check_failed");
      }
    }
    // Preparation already past the dispatch gate can still start SP work until resume settles.
    while (!settled.aborted) {
      try {
        await runtime.interrupt(runId);
      } catch (error) {
        logger.error({ runId, error: errorDiagnostics(error) }, "run_interrupt_failed");
      }
      await pause(STOP_POLL_MS, settled);
    }
  }

  async function resumeUntilStopped(runId: string): Promise<void> {
    const stop = new AbortController();
    const settled = new AbortController();
    const watching = watchStop(runId, stop, settled.signal);
    try {
      await runtime.resume(runId, stop.signal);
    } finally {
      settled.abort();
      await watching;
    }
  }

  return async (runId, attempt) => {
    if (!await store.isRunActive(runId)) return;
    if (!await store.isRunStopRequested(runId)) {
      try {
        await resumeUntilStopped(runId);
      } catch (error) {
        // The last attempt still cleans up: a failing pass must not leave the Project busy.
        if (!attempt.final) throw error;
        logger.error({ runId, error: errorDiagnostics(error) }, "run_final_pass_failed");
      }
    }
    if (attempt.final && await store.isRunActive(runId) && !await store.isRunStopRequested(runId)) {
      logger.warn({ runId }, "run_retry_budget_exhausted");
      await store.requestRunStop(runId);
    }
    if (await store.isRunStopRequested(runId)) {
      await runtime.stop(runId);
      await store.markRunStopFinalized(runId);
    }
    if (await store.isRunActive(runId)) throw new RunStillActiveError(runId);
  };
}

export async function startEvalRunWorker(options: EvalRunWorkerOptions): Promise<EvalRunWorker> {
  const { boss, logger } = options;
  const handle = createRunJobHandler(options);
  const work = { batchSize: 1, localConcurrency: options.concurrency, includeMetadata: true } as const;
  await boss.work(RUN_QUEUE, work, async (jobs: JobWithMetadata<RunJob>[]) => {
    for (const { data: { runId }, retryCount, retryLimit } of jobs) {
      try {
        await handle(runId, { final: retryCount >= retryLimit });
      } catch (error) {
        if (error instanceof RunStillActiveError) logger.info({ runId }, "run_job_deferred");
        else logger.error({ runId, error: errorDiagnostics(error) }, "run_job_failed");
        throw error;
      }
    }
  });
  return { close: () => boss.offWork(RUN_QUEUE, { wait: true }) };
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
