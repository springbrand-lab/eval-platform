import { EVIDENCE_EXPORT_MAX_PASSES, type EvidenceExportState } from "@eval-platform/eval-contracts";
import { Notice } from "@/components/ui/feedback";

function evidenceExportLines(state: EvidenceExportState, executionStatus: string): {
  title: string; items: string[]; error?: string;
} {
  const title = executionStatus === "failed"
    ? `证据导出失败（已用 ${state.passes}/${EVIDENCE_EXPORT_MAX_PASSES} 轮），已保留进度，重新收集执行结果会从断点继续`
    : `证据导出中 · 第 ${Math.min(state.passes + 1, EVIDENCE_EXPORT_MAX_PASSES)}/${EVIDENCE_EXPORT_MAX_PASSES} 轮`;
  const { progress } = state;
  const stored = (files: readonly { readonly sha256?: string }[]) => `${files.filter((file) => file.sha256).length}/${files.length}`;
  const items = progress
    ? [
        `产物 ${stored(progress.artifacts)}`,
        `执行输入 ${stored(progress.subjectInputs)}`,
        `轨迹 ${progress.trajectory.parts.length} 段（${progress.trajectory.done ? "已完成" : "读取中"}）`,
        ...(progress.omitted.length ? [`${progress.omitted.length} 个文件未纳入证据`] : []),
      ]
    : ["等待 SP 返回产物清单"];
  return { title, items, ...(state.lastError ? { error: state.lastError } : {}) };
}

export function EvidenceExportProgress({ state, executionStatus }: { state: EvidenceExportState | undefined; executionStatus: string }) {
  if (!state) return null;
  const { title, items, error } = evidenceExportLines(state, executionStatus);
  return <Notice tone={executionStatus === "failed" ? "danger" : "neutral"}>
    <p className="font-medium">{title}</p>
    <p className="mt-1 text-xs text-text-muted">{items.join(" · ")}</p>
    {error && <p className="mt-1 break-words text-xs text-text-muted">最近错误：{error}</p>}
  </Notice>;
}
