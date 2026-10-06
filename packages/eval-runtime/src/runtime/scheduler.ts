export interface AgentSchedulerOptions {
  readonly maxConcurrentDos: number;
}

export interface AgentScheduler {
  run<T>(tasks: readonly (() => Promise<T>)[]): Promise<readonly T[]>;
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
