import type { RunSnapshot } from "@/api-sdk/types";

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);

export function isFinished(status: string): boolean {
  return FINISHED.has(status);
}

export function runPhaseLabel(run: Pick<RunSnapshot, "phase" | "status" | "stopRequested">): string {
  if (run.stopRequested && !isFinished(run.status)) return "正在停止";
  if (isFinished(run.status)) return "已结束";
  return run.phase === "evaluation" ? "评估中" : "执行中";
}
