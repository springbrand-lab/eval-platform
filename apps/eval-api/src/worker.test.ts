import { describe, expect, it, vi } from "vitest";
import type { EvalRunWorkerOptions, RunNotifications } from "./worker.js";
import { startEvalRunWorker } from "./worker.js";

function makeNotifications() {
  let handlers: Parameters<RunNotifications["subscribe"]>[0] | undefined;
  const close = vi.fn(async () => undefined);
  const notifications: RunNotifications = {
    async subscribe(registered) {
      handlers = registered;
      registered.onConnected();
      return { close };
    },
  };
  return {
    notifications,
    close,
    notify(runId: string) { handlers?.onRunId(runId); },
    reconnect() { handlers?.onConnected(); },
  };
}

function workerOptions(
  notifications: RunNotifications,
  runIds: readonly string[],
  resume: EvalRunWorkerOptions["runtime"]["resume"],
): EvalRunWorkerOptions {
  return {
    notifications,
    runtime: { resume, interrupt: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    store: { listRecoverableRunIds: vi.fn(async (afterRunId?: string, limit = 100) => (
      runIds.filter((runId) => afterRunId === undefined || runId > afterRunId).slice(0, limit)
    )), isRunStopRequested: vi.fn(async () => false), markRunStopFinalized: vi.fn(async () => true) },
    scanIntervalMs: 60_000,
  };
}

describe("single-instance Run worker", () => {
  it("interrupts an active Run on a persisted stop notification, then finalizes it", async () => {
    const source = makeNotifications();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const resume = vi.fn(async (_runId: string, _signal?: AbortSignal) => gate);
    const options = workerOptions(source.notifications, ["run-1"], resume);
    let stopRequested = false;
    options.store.isRunStopRequested = vi.fn(async () => stopRequested);
    const worker = await startEvalRunWorker(options);
    try {
      await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
      const signal = resume.mock.calls[0]![1]!;
      stopRequested = true;
      source.notify("run-1");
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      await vi.waitFor(() => expect(options.runtime.interrupt).toHaveBeenCalledWith("run-1"));
      finish();
      await vi.waitFor(() => expect(options.runtime.stop).toHaveBeenCalledWith("run-1"));
      await vi.waitFor(() => expect(options.store.markRunStopFinalized).toHaveBeenCalledWith("run-1"));
    } finally {
      finish();
      await worker.close();
    }
  });

  it("finalizes a stop recovered on startup without resuming work", async () => {
    const source = makeNotifications();
    const resume = vi.fn(async () => undefined);
    const options = workerOptions(source.notifications, ["run-1"], resume);
    options.store.isRunStopRequested = vi.fn(async () => true);
    const worker = await startEvalRunWorker(options);
    try {
      await vi.waitFor(() => expect(options.runtime.stop).toHaveBeenCalledWith("run-1"));
      await vi.waitFor(() => expect(options.store.markRunStopFinalized).toHaveBeenCalledWith("run-1"));
      expect(resume).not.toHaveBeenCalled();
    } finally {
      await worker.close();
    }
  });
  it("does not dispatch Runs returned by an initial scan after shutdown starts", async () => {
    const source = makeNotifications();
    const abort = new AbortController();
    let releaseScan!: (runIds: readonly string[]) => void;
    const scanPage = new Promise<readonly string[]>((resolve) => { releaseScan = resolve; });
    const resume = vi.fn(async (_runId: string) => undefined);
    const options = workerOptions(source.notifications, [], resume);
    options.store.listRecoverableRunIds = vi.fn(() => scanPage);
    const startup = startEvalRunWorker({ ...options, signal: abort.signal });

    await vi.waitFor(() => expect(options.store.listRecoverableRunIds).toHaveBeenCalledOnce());
    abort.abort();
    releaseScan(["run-1", "run-2"]);
    const worker = await startup;

    expect(resume).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
    await worker.close();
  });

  it("scans after subscribing and does not execute an active Run twice", async () => {
    const source = makeNotifications();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const resume = vi.fn(async (_runId: string) => gate);
    const worker = await startEvalRunWorker(workerOptions(source.notifications, ["run-1"], resume));
    try {
      await vi.waitFor(() => expect(resume).toHaveBeenCalledExactlyOnceWith("run-1", expect.any(AbortSignal)));
      source.notify("run-1");
      await worker.scan();
      expect(resume).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      await worker.close();
    }
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("re-scans on reconnection and recovers a Run after its first attempt fails", async () => {
    const source = makeNotifications();
    const runIds: string[] = [];
    const resume = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary database outage"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const worker = await startEvalRunWorker({
      ...workerOptions(source.notifications, runIds, resume),
      onError,
    });
    try {
      runIds.push("run-1");
      source.notify("run-1");
      await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        message: "temporary database outage",
      })));
      source.reconnect();
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
      expect(resume).toHaveBeenNthCalledWith(2, "run-1", expect.any(AbortSignal));
    } finally {
      await worker.close();
    }
  });

  it("pages through unfinished Runs and stops receiving work after close", async () => {
    const source = makeNotifications();
    const runIds = Array.from({ length: 101 }, (_unused, index) => `run-${String(index).padStart(3, "0")}`);
    const resume = vi.fn(async (_runId: string) => undefined);
    const options = workerOptions(source.notifications, runIds, resume);
    const worker = await startEvalRunWorker(options);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(101));
    expect(options.store.listRecoverableRunIds).toHaveBeenCalledWith("run-099", 100);
    await worker.close();
    source.notify("run-102");
    await worker.scan();
    expect(resume).toHaveBeenCalledTimes(101);
  });

  it("limits active Runs without serializing all work into one Run", async () => {
    const source = makeNotifications();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resume = vi.fn(async (_runId: string) => gate);
    const worker = await startEvalRunWorker({
      ...workerOptions(source.notifications, ["run-1", "run-2", "run-3"], resume),
      maxConcurrentRuns: 2,
    });
    try {
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
      expect(resume.mock.calls.map(([runId]) => runId)).toEqual(["run-1", "run-2"]);
      release();
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(3));
    } finally {
      await worker.close();
      release();
    }
  });

  it("rejects an unavailable listener before running the startup scan", async () => {
    const options = workerOptions({
      async subscribe() { throw new Error("cannot connect to PostgreSQL"); },
    }, ["run-1"], vi.fn(async () => undefined));
    await expect(startEvalRunWorker(options)).rejects.toThrow("cannot connect to PostgreSQL");
    expect(options.store.listRecoverableRunIds).not.toHaveBeenCalled();
  });

  it("drains active Runs before closing and ignores new wakeups during shutdown", async () => {
    const source = makeNotifications();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resume = vi.fn(async (_runId: string) => gate);
    const worker = await startEvalRunWorker(workerOptions(source.notifications, ["run-1"], resume));
    await vi.waitFor(() => expect(resume).toHaveBeenCalledExactlyOnceWith("run-1", expect.any(AbortSignal)));

    let closed = false;
    const closing = worker.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(source.close).toHaveBeenCalledOnce());
    source.notify("run-2");
    expect(closed).toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);

    release();
    await closing;
    await worker.close();
    expect(closed).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
