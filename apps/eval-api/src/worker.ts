import type { EvalRunResumer, RunStopReporter, RuntimeRecoveryStore } from "@eval-platform/eval-runtime";
import { errorDiagnostics } from "@springbrand/http/server";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { RUN_QUEUE, type RunJob } from "./run-worker-queue.js";

/** How often an active Run re-reads its persisted stop request, and repeats SP interrupts after one. */
export const STOP_POLL_MS = 1_000;

export interface RunRecoveryStore extends RuntimeRecoveryStore {
  /**
   * For a Run waiting only for resource readiness checks whose earliest one is still ahead, completes
   * this job and schedules the next pass then; returns that time, or null for any other Run.
   */
  deferResourceCheck(runId: string, jobId: string): Promise<string | null>;
}

export interface RunJobHandlerOptions {
  readonly runtime: EvalRunResumer;
  readonly store: RunRecoveryStore;
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

/** Thrown while a Run keeps pending work after a pass, so pg-boss retries its job with backoff. */
export class RunStillActiveError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} is still active`);
    this.name = "RunStillActiveError";
  }
}

export interface RunJobAttempt {
  readonly jobId: string;
  readonly retryCount: number;
  /** At `retryCount >= retryLimit` the job is final: an active Run with pending work is stopped and cleaned up instead of retried. */
  readonly retryLimit: number;
}

/** Processes one Run job: resume, interrupt on a pending stop, then finalize that stop in the same pass. */
export function createRunJobHandler(
  { runtime, store, logger }: RunJobHandlerOptions,
): (runId: string, attempt: RunJobAttempt) => Promise<void> {
  async function watchStop(runId: string, stop: AbortController, settled: AbortSignal): Promise<void> {
    while (!stop.signal.aborted) {
      await pause(STOP_POLL_MS, settled);
      if (settled.aborted) return;
      try {
        if (await store.isRunStopPending(runId)) stop.abort();
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

  function stopReporter(runId: string): RunStopReporter {
    return {
      finalizing: (states) => logger.info({ runId, states }, "run_stop_finalizing"),
      stageStopped: (stage) => logger.info({ runId, ...stage }, "run_stage_stopped"),
    };
  }

  return async (runId, { jobId, retryCount, retryLimit }) => {
    if (!await store.isRunActive(runId)) return;
    const final = retryCount >= retryLimit;
    const stopPending = await store.isRunStopPending(runId);
    logger.info({ runId, jobId, retryCount, retryLimit, final, stopPending }, "run_job_start");
    if (!stopPending) {
      try {
        await resumeUntilStopped(runId);
      } catch (error) {
        // The last attempt still cleans up: a failing pass must not leave the Project busy.
        if (!final) throw error;
        logger.error({ runId, error: errorDiagnostics(error) }, "run_final_pass_failed");
      }
      const startAfter = await store.deferResourceCheck(runId, jobId);
      if (startAfter !== null) {
        logger.info({ runId, startAfter }, "run_resource_check_scheduled");
        return;
      }
    }
    if (final && await store.isRunActive(runId) && !await store.isRunStopPending(runId)) {
      logger.warn({ runId }, "run_retry_budget_exhausted");
      await store.requestRunStop(runId);
    }
    if (await store.isRunStopPending(runId)) {
      await runtime.stop(runId, stopReporter(runId));
      const finalized = await store.markRunStopFinalized(runId);
      logger[finalized ? "info" : "warn"]({ runId, finalized }, "run_stop_finalized");
    }
    if (await store.isRunActive(runId)) throw new RunStillActiveError(runId);
  };
}

export async function startEvalRunWorker(options: EvalRunWorkerOptions): Promise<EvalRunWorker> {
  const { boss, logger } = options;
  const handle = createRunJobHandler(options);
  const work = { batchSize: 1, localConcurrency: options.concurrency, includeMetadata: true } as const;
  await boss.work(RUN_QUEUE, work, async (jobs: JobWithMetadata<RunJob>[]) => {
    for (const { id, data: { runId }, retryCount, retryLimit } of jobs) {
      try {
        await handle(runId, { jobId: id, retryCount, retryLimit });
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
