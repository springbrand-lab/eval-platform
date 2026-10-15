import type { EvalRunResumer, RuntimeRecoveryStore } from "@eval-platform/eval-runtime";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_QUEUE, type RunJob } from "./run-worker-queue.js";
import { createRunJobHandler, RunStillActiveError, startEvalRunWorker, STOP_POLL_MS } from "./worker.js";

const retry = { final: false };
const finalRetry = { final: true };

function fixture(input: { active?: boolean[]; stopRequested?: () => boolean } = {}) {
  const active = [...(input.active ?? [true, false])];
  const runtime = {
    resume: vi.fn<EvalRunResumer["resume"]>(async () => undefined),
    interrupt: vi.fn<EvalRunResumer["interrupt"]>(async () => undefined),
    stop: vi.fn<EvalRunResumer["stop"]>(async () => undefined),
  };
  const store = {
    isRunActive: vi.fn<RuntimeRecoveryStore["isRunActive"]>(async () => active.shift() ?? false),
    isRunStopRequested: vi.fn<RuntimeRecoveryStore["isRunStopRequested"]>(async () => input.stopRequested?.() ?? false),
    requestRunStop: vi.fn<RuntimeRecoveryStore["requestRunStop"]>(async () => undefined),
    markRunStopFinalized: vi.fn<RuntimeRecoveryStore["markRunStopFinalized"]>(async () => true),
  };
  const logger = pino({ level: "silent" });
  return { runtime, store, logger, handle: createRunJobHandler({ runtime, store, logger }) };
}

describe("Run job handler", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("completes a job whose Run is no longer active without resuming it", async () => {
    const { runtime, handle } = fixture({ active: [false] });
    await handle("run-1", retry);
    expect(runtime.resume).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("resumes an active Run and completes once every stage is terminal", async () => {
    const { runtime, handle } = fixture({ active: [true, false] });
    await handle("run-1", retry);
    expect(runtime.resume).toHaveBeenCalledExactlyOnceWith("run-1", expect.any(AbortSignal));
    expect(runtime.resume.mock.calls[0]![1]!.aborted).toBe(false);
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("fails the job for a backoff retry while the Run stays active", async () => {
    const { handle } = fixture({ active: [true, true] });
    await expect(handle("run-1", retry)).rejects.toBeInstanceOf(RunStillActiveError);
  });

  it("interrupts an active Run on a persisted stop request, then finalizes the stop", async () => {
    let stopRequested = false;
    const { runtime, store, handle } = fixture({ active: [true, false], stopRequested: () => stopRequested });
    let finish!: () => void;
    runtime.resume.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const handling = handle("run-1", retry);
    await vi.waitFor(() => expect(runtime.resume).toHaveBeenCalledOnce());
    const signal = runtime.resume.mock.calls[0]![1]!;

    await vi.advanceTimersByTimeAsync(STOP_POLL_MS);
    expect(signal.aborted).toBe(false);
    stopRequested = true;
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS);
    expect(signal.aborted).toBe(true);
    expect(runtime.interrupt).toHaveBeenCalledExactlyOnceWith("run-1");
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS);
    expect(runtime.interrupt).toHaveBeenCalledTimes(2);
    expect(runtime.stop).not.toHaveBeenCalled();

    finish();
    await handling;
    expect(runtime.stop).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(store.markRunStopFinalized).toHaveBeenCalledExactlyOnceWith("run-1");
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS * 3);
    expect(runtime.interrupt).toHaveBeenCalledTimes(2);
  });

  it("finalizes a stop requested before the job ran without resuming work", async () => {
    const { runtime, store, handle } = fixture({ active: [true, false], stopRequested: () => true });
    await handle("run-1", retry);
    expect(runtime.resume).not.toHaveBeenCalled();
    expect(runtime.stop).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(store.markRunStopFinalized).toHaveBeenCalledExactlyOnceWith("run-1");
  });

  it("retries a stop whose cleanup could not be finalized yet", async () => {
    const { store, handle } = fixture({ active: [true, true], stopRequested: () => true });
    store.markRunStopFinalized.mockResolvedValue(false);
    await expect(handle("run-1", retry)).rejects.toBeInstanceOf(RunStillActiveError);
  });

  it("stops and cleans up a Run that is still active on the final retry", async () => {
    let stopRequested = false;
    const { runtime, store, handle } = fixture({ active: [true, true, false], stopRequested: () => stopRequested });
    store.requestRunStop.mockImplementation(async () => { stopRequested = true; });
    await handle("run-1", finalRetry);
    expect(runtime.resume).toHaveBeenCalledOnce();
    expect(store.requestRunStop).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(runtime.stop).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(store.markRunStopFinalized).toHaveBeenCalledExactlyOnceWith("run-1");
  });

  it("still stops and cleans up when the final pass throws", async () => {
    let stopRequested = false;
    const { runtime, store, handle } = fixture({ active: [true, true, false], stopRequested: () => stopRequested });
    runtime.resume.mockRejectedValue(new Error("Eval SP unavailable"));
    store.requestRunStop.mockImplementation(async () => { stopRequested = true; });
    await handle("run-1", finalRetry);
    expect(store.requestRunStop).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(runtime.stop).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(store.markRunStopFinalized).toHaveBeenCalledExactlyOnceWith("run-1");
  });

  it("rethrows a failing pass before the final retry", async () => {
    const { runtime, store, handle } = fixture({ active: [true] });
    runtime.resume.mockRejectedValue(new Error("Eval SP unavailable"));
    await expect(handle("run-1", retry)).rejects.toThrow("Eval SP unavailable");
    expect(store.requestRunStop).not.toHaveBeenCalled();
  });

  it("does not request a system stop when the final pass finishes the Run", async () => {
    const { runtime, store, handle } = fixture({ active: [true, false] });
    await handle("run-1", finalRetry);
    expect(store.requestRunStop).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("keeps watching for a stop after a transient stop-check failure", async () => {
    let checks = 0;
    const { runtime, store, logger, handle } = fixture({ active: [true, false] });
    const logged = vi.spyOn(logger, "error");
    store.isRunStopRequested.mockImplementation(async () => {
      checks += 1;
      if (checks === 2) throw new Error("connection reset");
      return checks > 2;
    });
    let finish!: () => void;
    runtime.resume.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const handling = handle("run-1", retry);
    await vi.waitFor(() => expect(runtime.resume).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }), "run_stop_check_failed");
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS);
    expect(runtime.resume.mock.calls[0]![1]!.aborted).toBe(true);
    finish();
    await handling;
    expect(runtime.stop).toHaveBeenCalledOnce();
  });
});

describe("Run worker", () => {
  function fakeBoss() {
    let handler: ((jobs: JobWithMetadata<RunJob>[]) => Promise<unknown>) | undefined;
    const boss = {
      work: vi.fn(async (_name: string, _options: object, registered: typeof handler) => {
        handler = registered;
        return "worker-id";
      }),
      offWork: vi.fn(async () => undefined),
    };
    const job = (runId: string, retryCount: number) => ({
      id: `job-${runId}`, name: RUN_QUEUE, data: { runId }, retryCount, retryLimit: 2,
    }) as JobWithMetadata<RunJob>;
    return {
      boss: boss as unknown as Pick<PgBoss, "work" | "offWork">,
      work: boss.work,
      offWork: boss.offWork,
      deliver: (runId: string, retryCount = 0) => handler!([job(runId, retryCount)]),
    };
  }

  it("consumes Run jobs with the configured local concurrency and stops fetching on close", async () => {
    const source = fakeBoss();
    const { runtime, store, logger } = fixture({ active: [true, false] });
    const worker = await startEvalRunWorker({ boss: source.boss, runtime, store, logger, concurrency: 3 });
    expect(source.work).toHaveBeenCalledExactlyOnceWith(RUN_QUEUE, { batchSize: 1, localConcurrency: 3, includeMetadata: true }, expect.any(Function));

    await source.deliver("run-1");
    expect(runtime.resume).toHaveBeenCalledExactlyOnceWith("run-1", expect.any(AbortSignal));
    await worker.close();
    expect(source.offWork).toHaveBeenCalledExactlyOnceWith(RUN_QUEUE, { wait: true });
  });

  it("reports a deferred Run without an error log and rethrows so pg-boss retries it", async () => {
    const source = fakeBoss();
    const { runtime, store, logger } = fixture({ active: [true, true] });
    const info = vi.spyOn(logger, "info");
    const error = vi.spyOn(logger, "error");
    await startEvalRunWorker({ boss: source.boss, runtime, store, logger, concurrency: 1 });
    await expect(source.deliver("run-1")).rejects.toBeInstanceOf(RunStillActiveError);
    expect(info).toHaveBeenCalledWith({ runId: "run-1" }, "run_job_deferred");
    expect(error).not.toHaveBeenCalled();
  });

  it("marks the job's last retry as final", async () => {
    const source = fakeBoss();
    let stopRequested = false;
    const { runtime, store, logger } = fixture({ active: [true, true, false], stopRequested: () => stopRequested });
    store.requestRunStop.mockImplementation(async () => { stopRequested = true; });
    await startEvalRunWorker({ boss: source.boss, runtime, store, logger, concurrency: 1 });
    await source.deliver("run-1", 2);
    expect(store.requestRunStop).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(runtime.stop).toHaveBeenCalledExactlyOnceWith("run-1");
  });

  it("logs a failed Run pass with redacted diagnostics and rethrows it", async () => {
    const source = fakeBoss();
    const { runtime, store, logger } = fixture({ active: [true] });
    runtime.resume.mockRejectedValue(new Error("request to https://user:secret@sp.test failed"));
    const error = vi.spyOn(logger, "error");
    await startEvalRunWorker({ boss: source.boss, runtime, store, logger, concurrency: 1 });
    await expect(source.deliver("run-1")).rejects.toThrow("failed");
    expect(error).toHaveBeenCalledWith({
      runId: "run-1",
      error: expect.objectContaining({ message: "request to https://[Redacted]@sp.test failed" }),
    }, "run_job_failed");
  });
});
