import type { SamplingStageState } from "@eval-platform/eval-contracts";
import type { RunSnapshot, StageStatistics } from "@/api-sdk/types";
import { RESOURCES_PENDING_LABEL } from "@/features/metrics/resource-collection";

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);
const IN_PROGRESS = new Set(["starting", "running", "retrying"]);

export type StageKind = "execution" | "evaluation";

export function isFinished(status: string): boolean {
  return FINISHED.has(status);
}

export function isStageInProgress(status: string): boolean {
  return IN_PROGRESS.has(status);
}

/** A stop not yet finalized; a recollection after a finalized stop is ordinary work. */
export function isStopping(run: Pick<RunSnapshot, "status" | "stopRequested" | "stopFinalized">): boolean {
  return run.stopRequested === true && run.stopFinalized !== true && !isFinished(run.status);
}

export function runPhaseLabel(run: Pick<RunSnapshot, "phase" | "status" | "stopRequested" | "stopFinalized">): string {
  if (isStopping(run)) return "正在停止";
  if (isFinished(run.status)) return "已结束";
  return run.phase === "evaluation" ? "评估中" : "执行中";
}

/** Work beyond running the Agent; only resource collection outlives a terminal status. */
export function stagePendingHint(stage: StageKind, state: SamplingStageState): string | undefined {
  if (isStageInProgress(state.status)) {
    if (state.evidencePending) return stage === "execution" ? "执行 Agent 已完成 · 整理证据中" : "评估 Agent 已完成 · 整理证据中";
    if (state.collectionPending) return "补收结果中";
    if (state.observationPending) return "确认 Agent 状态中";
  }
  return state.resourcesPending ? RESOURCES_PENDING_LABEL : undefined;
}

export function stageProgressLabel(stage: StageKind, state: SamplingStageState): string | undefined {
  const hint = stagePendingHint(stage, state);
  if (hint) return hint;
  if (!isStageInProgress(state.status)) return undefined;
  return stage === "execution" ? "执行中" : "评估中";
}

/** Queued records are waiting, not in progress. */
export function stageInProgressCount(stage: Pick<StageStatistics, "statuses">): number {
  return stage.statuses.starting + stage.statuses.running + stage.statuses.retrying;
}
