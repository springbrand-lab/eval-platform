import { describe, expect, it } from "vitest";
import { isStopping, runPhaseLabel, stageInProgressCount, stagePendingHint, stageProgressLabel } from "./run-status";

describe("runPhaseLabel", () => {
  it("shows a pending stop, but not a recollection after a finalized stop, as stopping", () => {
    const run = { phase: "execution", status: "retrying", stopRequested: true } as const;
    expect(isStopping(run)).toBe(true);
    expect(runPhaseLabel(run)).toBe("正在停止");
    expect(isStopping({ ...run, stopFinalized: true })).toBe(false);
    expect(runPhaseLabel({ ...run, stopFinalized: true })).toBe("执行中");
  });
});

describe("stageProgressLabel", () => {
  it("names an active execution or evaluation", () => {
    expect(stageProgressLabel("execution", { status: "running" })).toBe("执行中");
    expect(stageProgressLabel("evaluation", { status: "retrying" })).toBe("评估中");
  });

  it("leaves queued work as the shared queued status", () => {
    expect(stageProgressLabel("execution", { status: "queued" })).toBeUndefined();
    expect(stageProgressLabel("evaluation", { status: "queued" })).toBeUndefined();
  });

  it("tells collection and confirmation apart from a running Agent", () => {
    expect(stageProgressLabel("execution", { status: "retrying", evidencePending: true })).toBe("执行 Agent 已完成 · 整理证据中");
    expect(stageProgressLabel("evaluation", { status: "retrying", evidencePending: true })).toBe("评估 Agent 已完成 · 整理证据中");
    expect(stageProgressLabel("evaluation", { status: "retrying", collectionPending: true })).toBe("补收结果中");
    expect(stageProgressLabel("evaluation", { status: "retrying", observationPending: { passes: 2, lastError: "Submission WebSocket closed before terminal status" } })).toBe("确认 Agent 状态中");
    expect(stageProgressLabel("execution", { status: "running", resourcesPending: { deadline: "2026-01-01T00:10:00.000Z" } })).toBe("补采资源中");
  });

  it("keeps resource collection visible after a terminal status but ignores stale stage markers", () => {
    expect(stageProgressLabel("execution", { status: "succeeded", resourcesPending: { deadline: "2026-01-01T00:10:00.000Z", nextAttemptAt: "2026-01-01T00:00:00.000Z" } })).toBe("补采资源中");
    expect(stagePendingHint("evaluation", { status: "failed", resourcesPending: { deadline: "2026-01-01T00:10:00.000Z", lastError: "timeout" } })).toBe("补采资源中");
    expect(stageProgressLabel("execution", { status: "succeeded", evidencePending: true })).toBeUndefined();
    expect(stagePendingHint("execution", { status: "running" })).toBeUndefined();
  });

  it("counts only active records as in progress", () => {
    expect(stageInProgressCount({ statuses: { queued: 8, starting: 2, running: 3, retrying: 0, succeeded: 0, failed: 0, cancelled: 0 } })).toBe(5);
  });
});
