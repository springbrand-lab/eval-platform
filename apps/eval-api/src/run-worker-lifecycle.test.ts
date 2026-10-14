import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startWorkerWithSignals } from "./run-worker-lifecycle.js";

describe("Run worker process lifecycle", () => {
  it("drains a worker when shutdown arrives during startup", async () => {
    const signals = new EventEmitter();
    let releaseStartup!: (worker: { close(): Promise<void> }) => void;
    const started = new Promise<{ close(): Promise<void> }>((resolve) => { releaseStartup = resolve; });
    const worker = { close: vi.fn(async () => undefined) };
    const closeDatabase = vi.fn(async () => undefined);
    const onError = vi.fn();
    let startupSignal: AbortSignal | undefined;
    const startup = startWorkerWithSignals({
      signals,
      start(signal) {
        startupSignal = signal;
        return started;
      },
      closeDatabase,
      onError,
    });

    signals.emit("SIGTERM");
    expect(startupSignal?.aborted).toBe(true);
    expect(worker.close).not.toHaveBeenCalled();
    releaseStartup(worker);
    await startup;

    expect(worker.close).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("closes the database once if startup fails", async () => {
    const signals = new EventEmitter();
    const closeDatabase = vi.fn(async () => undefined);
    await expect(startWorkerWithSignals({
      signals,
      start: async () => { throw new Error("listener unavailable"); },
      closeDatabase,
      onError: vi.fn(),
    })).rejects.toThrow("listener unavailable");
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });
});
