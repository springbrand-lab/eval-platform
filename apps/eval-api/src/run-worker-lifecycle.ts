type Signal = "SIGINT" | "SIGTERM";

export interface WorkerSignalSource {
  once(signal: Signal, listener: () => void): unknown;
  off(signal: Signal, listener: () => void): unknown;
}

export async function startWorkerWithSignals(input: {
  readonly signals: WorkerSignalSource;
  readonly start: () => Promise<{ close(): Promise<void> }>;
  readonly closeDatabase: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}): Promise<void> {
  let worker: { close(): Promise<void> } | undefined;
  let stopRequested = false;
  let closing: Promise<void> | undefined;
  let databaseClosing: Promise<void> | undefined;
  const closeDatabase = (): Promise<void> => {
    databaseClosing ??= input.closeDatabase();
    return databaseClosing;
  };
  const onSignal = (): void => {
    void close().catch(input.onError);
  };
  const removeListeners = (): void => {
    input.signals.off("SIGINT", onSignal);
    input.signals.off("SIGTERM", onSignal);
  };
  const close = (): Promise<void> => {
    stopRequested = true;
    if (!worker) return Promise.resolve();
    closing ??= worker.close().finally(async () => {
      removeListeners();
      await closeDatabase();
    });
    return closing;
  };

  input.signals.once("SIGINT", onSignal);
  input.signals.once("SIGTERM", onSignal);
  try {
    worker = await input.start();
    if (stopRequested) await close();
  } catch (error) {
    removeListeners();
    await closeDatabase();
    throw error;
  }
}
