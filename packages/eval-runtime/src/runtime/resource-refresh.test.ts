import { describe, expect, it, vi } from "vitest";
import { RESOURCE_CHECK_INTERVAL_MS, type HarnessConfig, type SamplingStageState } from "@eval-platform/eval-contracts";

import type { AgentHandle } from "../harness/model.js";
import type { AgentAttemptRecord, AgentLifecycleDependencies } from "./agent-lifecycle.js";
import { refreshFinishedStage } from "./resource-refresh.js";
import { STOPPED_RESOURCES_ERROR } from "./resources.js";
import type { RetryController } from "./retry.js";

const NOW = "2026-10-20T00:01:00.000Z";

function refreshWith(deadline: string) {
  const onError = vi.fn();
  const persist = vi.fn(async (_attempts: readonly AgentAttemptRecord[], _state: SamplingStageState) => undefined);
  const attempts = [{ attemptNumber: 1 }] as unknown as readonly AgentAttemptRecord[];
  const dependencies = {
    now: () => NOW, onError, log: () => undefined,
  } as unknown as AgentLifecycleDependencies;
  const run = () => refreshFinishedStage(dependencies, {
    stage: "execution",
    samplingId: "sampling-1",
    handle: { chatId: "chat-1" } as AgentHandle,
    harnessConfig: {} as HarnessConfig,
    retryController: {} as RetryController,
    attempts,
    state: { status: "succeeded", resourcesPending: { deadline, nextAttemptAt: NOW } },
    agentEnded: () => { throw new Error("unexpected refresh failure"); },
    persist,
  });
  return { run, persist, onError, attempts };
}

describe("refreshFinishedStage", () => {
  it("backs off one check interval and records the error after an unexpected failure", async () => {
    const deadline = "2026-10-20T00:10:00.000Z";
    const { run, persist, onError, attempts } = refreshWith(deadline);

    await run();

    expect(onError).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledExactlyOnceWith(attempts, {
      status: "succeeded",
      resourcesPending: {
        deadline,
        nextAttemptAt: new Date(Date.parse(NOW) + RESOURCE_CHECK_INTERVAL_MS).toISOString(),
        lastError: "unexpected refresh failure",
      },
    });
  });

  it("ends the wait when a pass fails past the deadline", async () => {
    const { run, persist, onError, attempts } = refreshWith(NOW);

    await run();

    expect(onError).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledExactlyOnceWith(attempts, { status: "succeeded" });
  });

  it("caps the backoff at the deadline", async () => {
    const deadline = new Date(Date.parse(NOW) + 1_000).toISOString();
    const { run, persist } = refreshWith(deadline);

    await run();

    expect(persist.mock.calls[0]![1].resourcesPending).toMatchObject({ deadline, nextAttemptAt: deadline });
  });

  it("records owed resources failed when finalizing a stop, keeping their download count", async () => {
    const persist = vi.fn(async (_attempts: readonly AgentAttemptRecord[], _state: SamplingStageState) => undefined);
    const scope = { chatId: "chat-1", idempotencyKey: "execution:sampling-1" };
    const attempt: AgentAttemptRecord = { attemptNumber: 1, status: "completed", completedAt: NOW, resources: { status: "pending", scope, downloads: 2 } };
    await refreshFinishedStage({ now: () => NOW, finalizingStop: true } as unknown as AgentLifecycleDependencies, {
      stage: "execution", samplingId: "sampling-1", handle: undefined, harnessConfig: {} as HarnessConfig,
      retryController: {} as RetryController, attempts: [attempt],
      state: { status: "succeeded", resourcesPending: { deadline: NOW } }, agentEnded: () => true, persist,
    });
    expect(persist).toHaveBeenCalledExactlyOnceWith([{ ...attempt, resources: {
      status: "failed", scope, collectedAt: NOW, error: STOPPED_RESOURCES_ERROR, downloads: 2,
    } }], { status: "succeeded" });
  });
});
