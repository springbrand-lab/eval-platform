export interface AgentSchedulerOptions {
  readonly maxConcurrentDos: number;
}

export interface AgentScheduler {
  run<T>(tasks: readonly (() => Promise<T>)[]): Promise<readonly T[]>;
}

/**
 * A bounded queue whose producers may enqueue work while earlier work is running.
 * `close()` only closes the admission side; it resolves after every queued task has
 * settled. Task failures are collected so one failed Agent does not stop the other
 * tasks from draining.
 */
export interface AgentTaskQueue {
  enqueue(task: () => Promise<void>): void;
  close(): Promise<void>;
}

export function createAgentTaskQueue(options: AgentSchedulerOptions): AgentTaskQueue {
  if (!Number.isInteger(options.maxConcurrentDos) || options.maxConcurrentDos < 1) {
    throw new Error("maxConcurrentDos must be a positive integer");
  }

  const pending: (() => Promise<void>)[] = [];
  const failures: unknown[] = [];
  let active = 0;
  let closed = false;
  let settled = false;
  let resolveClosed: (() => void) | undefined;
  let rejectClosed: ((error: unknown) => void) | undefined;
  let closePromise: Promise<void> | undefined;

  const settle = (): void => {
    if (!closed || pending.length > 0 || active > 0 || settled) return;
    settled = true;
    if (failures.length > 0) {
      rejectClosed?.(new AggregateError(failures, "Agent task queue failed"));
    } else {
      resolveClosed?.();
    }
  };

  const pump = (): void => {
    while (active < options.maxConcurrentDos && pending.length > 0) {
      const task = pending.shift()!;
      active += 1;
      void Promise.resolve()
        .then(task)
        .catch((error: unknown) => {
          failures.push(error);
        })
        .finally(() => {
          active -= 1;
          pump();
          settle();
        });
    }
    settle();
  };

  return {
    enqueue(task) {
      // A running task may produce more work after the consumer has closed the
      // external admission side. Once no task is active, late producers are a
      // programming error and cannot be drained safely.
      if (closed && active === 0) throw new Error("Cannot enqueue work after the Agent task queue is closed");
      pending.push(task);
      pump();
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
        pump();
      });
      // `pump()` may settle synchronously for an empty queue, before the promise
      // callbacks above are assigned. Run it once more after assignment.
      settle();
      return closePromise;
    },
  };
}

export function createAgentScheduler(options: AgentSchedulerOptions): AgentScheduler {
  if (!Number.isInteger(options.maxConcurrentDos) || options.maxConcurrentDos < 1) {
    throw new Error("maxConcurrentDos must be a positive integer");
  }

  return {
    async run<T>(tasks: readonly (() => Promise<T>)[]) {
      const results: T[] = [];
      let nextIndex = 0;
      const workerCount = Math.min(options.maxConcurrentDos, tasks.length);

      const worker = async (): Promise<void> => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          const task = tasks[index];
          if (!task) return;
          results[index] = await task();
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      return results;
    },
  };
}
