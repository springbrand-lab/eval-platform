import type { EvalRuntime, RuntimeRecoveryStore } from "@eval-platform/eval-runtime";
import { Client } from "pg";

const RUN_CHANNEL = "eval_run_created";
const SCAN_PAGE_SIZE = 100;

export interface RunNotifications {
  subscribe(handlers: {
    readonly onRunId: (runId: string) => void;
    readonly onConnected: () => void;
    readonly onError: (error: Error) => void;
  }): Promise<{ close(): Promise<void> }>;
}

export interface EvalRunWorker {
  wake(runId: string): void;
  scan(): Promise<void>;
  close(): Promise<void>;
}

export interface EvalRunWorkerOptions {
  readonly runtime: Pick<EvalRuntime, "resume">;
  readonly store: RuntimeRecoveryStore;
  readonly notifications: RunNotifications;
  readonly maxConcurrentRuns?: number;
  readonly scanIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly onError?: (error: Error) => void;
}

export function createPostgresRunNotifications(connectionString: string): RunNotifications {
  return {
    async subscribe(handlers) {
      let closed = false;
      let client: Client | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;

      const report = (error: unknown): void => {
        try {
          handlers.onError(asError(error));
        } catch (reportingError) {
          console.error(error, reportingError);
        }
      };

      const scheduleReconnect = (): void => {
        if (closed || retryTimer) return;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void connect(false);
        }, 1_000);
      };

      const connect = async (initial: boolean): Promise<void> => {
        const next = new Client({ connectionString });
        client = next;
        let listening = false;
        const lost = (): void => {
          if (client !== next) return;
          client = undefined;
          void next.end().catch(() => undefined);
          if (listening || !initial) scheduleReconnect();
        };
        next.on("notification", (message) => {
          if (message.channel === RUN_CHANNEL && message.payload) handlers.onRunId(message.payload);
        });
        next.on("error", (error) => {
          report(error);
          lost();
        });
        next.on("end", lost);
        try {
          await next.connect();
          if (client !== next) throw new Error("Run notification connection closed during setup");
          await next.query(`LISTEN ${RUN_CHANNEL}`);
          if (client !== next || closed) throw new Error("Run notification connection closed during setup");
          listening = true;
          handlers.onConnected();
        } catch (error) {
          if (client === next) client = undefined;
          await next.end().catch(() => undefined);
          if (closed) return;
          report(error);
          if (initial) {
            closed = true;
            if (retryTimer) clearTimeout(retryTimer);
            throw error;
          }
          scheduleReconnect();
        }
      };

      await connect(true);
      return {
        async close() {
          closed = true;
          if (retryTimer) clearTimeout(retryTimer);
          const current = client;
          client = undefined;
          await current?.end().catch(() => undefined);
        },
      };
    },
  };
}

export async function startEvalRunWorker(options: EvalRunWorkerOptions): Promise<EvalRunWorker> {
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 8;
  const scanIntervalMs = options.scanIntervalMs ?? 30_000;
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
    throw new Error("maxConcurrentRuns must be a positive integer");
  }
  if (!Number.isInteger(scanIntervalMs) || scanIntervalMs < 1) {
    throw new Error("scanIntervalMs must be a positive integer");
  }

  let closed = options.signal?.aborted ?? false;
  let ready = false;
  let scanning: Promise<void> | undefined;
  const pending = new Set<string>();
  const active = new Map<string, Promise<void>>();
  const report = (error: unknown): void => {
    try {
      (options.onError ?? console.error)(asError(error));
    } catch (reportingError) {
      console.error(error, reportingError);
    }
  };
  let closeWorker: (() => Promise<void>) | undefined;
  const onAbort = (): void => {
    closed = true;
    pending.clear();
    if (closeWorker) void closeWorker().catch(report);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const drain = (): void => {
    while (ready && !closed && active.size < maxConcurrentRuns && pending.size > 0) {
      const runId = pending.values().next().value!;
      pending.delete(runId);
      const task = Promise.resolve().then(() => options.runtime.resume(runId))
        .catch(report)
        .finally(() => {
          active.delete(runId);
          drain();
        });
      active.set(runId, task);
    }
  };
  const wake = (runId: string): void => {
    if (closed || !runId || pending.has(runId) || active.has(runId)) return;
    pending.add(runId);
    drain();
  };
  const scan = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (scanning) return scanning;
    scanning = (async () => {
      let afterRunId: string | undefined;
      while (!closed) {
        const runIds = await options.store.listRecoverableRunIds(afterRunId, SCAN_PAGE_SIZE);
        for (const runId of runIds) wake(runId);
        if (runIds.length < SCAN_PAGE_SIZE) return;
        afterRunId = runIds.at(-1);
      }
    })().finally(() => {
      scanning = undefined;
    });
    return scanning;
  };

  const subscription = await options.notifications.subscribe({
    onRunId: wake,
    onConnected: () => { if (ready) void scan().catch(report); },
    onError: report,
  });
  ready = true;
  drain();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    options.signal?.removeEventListener("abort", onAbort);
    if (timer) clearInterval(timer);
    pending.clear();
    closing = (async () => {
      try {
        await subscription.close();
      } finally {
        await scanning?.catch(report);
        await Promise.allSettled(active.values());
      }
    })();
    return closing;
  };
  closeWorker = close;
  try {
    await scan();
  } catch (error) {
    await close();
    throw error;
  }
  if (closed) await close();
  else timer = setInterval(() => { void scan().catch(report); }, scanIntervalMs);
  return {
    wake,
    scan,
    close,
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
