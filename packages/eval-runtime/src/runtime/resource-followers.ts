import type { SamplingStageState } from "@eval-platform/eval-contracts";
import { isPendingSamplingStatus } from "@eval-platform/eval-contracts";

/** One finished stage whose resources are still owed: how to read its state and run its due check. */
export interface ResourceFollow {
  readonly read: () => Promise<SamplingStageState | undefined>;
  readonly refresh: () => Promise<void>;
}

export function waitOrAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs each finished stage's resource checks on its own schedule while the pass still has Agent
 * work, so a Sampling's resources never wait for the slowest Sampling of the Run. Once the pass's
 * Agent work ends, `finish` cancels the remaining waits and the Run's next pass takes them over.
 */
export class ResourceFollowers {
  readonly #controller = new AbortController();
  readonly #tasks: Promise<void>[] = [];

  constructor(
    private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
    private readonly now: () => string,
    private readonly report: (error: unknown) => void,
    stopSignal?: AbortSignal,
  ) {
    if (stopSignal?.aborted) this.#controller.abort();
    else stopSignal?.addEventListener("abort", () => this.#controller.abort(), { once: true });
  }

  follow(follow: ResourceFollow): void {
    const signal = this.#controller.signal;
    if (signal.aborted) return;
    this.#tasks.push((async () => {
      let previousDue: string | undefined;
      for (;;) {
        const state = await follow.read();
        const due = state?.resourcesPending?.nextAttemptAt;
        // A check that did not move its schedule is left to the next pass instead of repeating at once.
        if (signal.aborted || !state || due === undefined || isPendingSamplingStatus(state.status) || due === previousDue) return;
        previousDue = due;
        await this.wait(Math.max(0, Date.parse(due) - Date.parse(this.now())), signal);
        if (signal.aborted) return;
        await follow.refresh();
      }
    })().catch(this.report));
  }

  async finish(): Promise<void> {
    this.#controller.abort();
    await Promise.allSettled(this.#tasks);
  }
}
