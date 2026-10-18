import type { RunSnapshot, StageStatistics } from "@/api-sdk/types";

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);
const IN_PROGRESS = new Set(["starting", "running", "retrying"]);

export function isFinished(status: string): boolean {
  return FINISHED.has(status);
}

export function runPhaseLabel(run: Pick<RunSnapshot, "phase" | "status" | "stopRequested">): string {
  if (run.stopRequested && !isFinished(run.status)) return "正在停止";
  if (isFinished(run.status)) return "已结束";
  return run.phase === "evaluation" ? "评估中" : "执行中";
}

export function stageProgressLabel(stage: "execution" | "evaluation", status: string): string | undefined {
  if (!IN_PROGRESS.has(status)) return undefined;
  return stage === "execution" ? "执行中" : "评估中";
}

/** Counts stage records that are actively starting, running or retrying; queued records are waiting. */
export function stageInProgressCount(stage: Pick<StageStatistics, "statuses">): number {
  return stage.statuses.starting + stage.statuses.running + stage.statuses.retrying;
}
