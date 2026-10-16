import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isPendingSamplingStatus, type SamplingStageState } from "@eval-platform/eval-contracts";
import { toast } from "sonner";
import { getProjectRun, recollectResult } from "@/api-sdk/runs-api";
import { getSamplingDetail } from "@/api-sdk/metrics-api";
import { projectKeys } from "@/api-sdk/projects-api";
import { Button } from "@/components/ui/button";
import { ErrorBlock } from "@/components/ui/feedback";
import { refreshProjectResults } from "@/features/projects/use-project";

export function RecollectResultButton({ projectId, samplingId, evaluationId, stage, eligible, busy }: {
  projectId: string; samplingId: string; evaluationId?: string; stage: SamplingStageState; eligible: boolean; busy: boolean;
}) {
  const client = useQueryClient();
  const collect = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const accepted = await recollectResult(projectId, evaluationId ? "evaluations" : "samplings", evaluationId ?? samplingId);
      if (!accepted.queued) return;
      await client.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
      // Await the persisted job, not an optimistic UI status. Closing this view does not cancel collection.
      const deadline = Date.now() + 120_000;
      while (true) {
        const { run } = await getProjectRun(projectId, accepted.runId);
        if (!isPendingSamplingStatus(run.status)) break;
        if (Date.now() >= deadline) throw new Error("后台仍在收集结果，可关闭此页面，稍后查看状态。");
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const detail = await getSamplingDetail(projectId, samplingId);
      const state = evaluationId ? detail.evaluations.find((item) => item.record.evaluationId === evaluationId)?.record.status : detail.subject.stage;
      if (state?.status !== "succeeded") throw new Error(state?.lastError ?? "本次收集未成功，可查看错误后再次尝试。");
    },
    onSuccess: () => toast.success(evaluationId ? "评估结果已重新收集" : "执行产物与完整轨迹已重新收集；未执行的评估需另行发起"),
    onSettled: async () => {
      await Promise.all([refreshProjectResults(client, projectId), client.invalidateQueries({ queryKey: projectKeys.detail(projectId) })]);
    },
  });
  if (!eligible || (stage.status !== "failed" && !stage.collectionPending && !collect.isPending && !collect.error)) return null;
  return <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
    <div className="flex flex-wrap items-center gap-3"><Button loading={collect.isPending || stage.collectionPending} disabled={busy || collect.isPending || !!stage.collectionPending} onClick={() => collect.mutate()}>
      {stage.collectionPending || collect.isPending ? "正在收集结果" : evaluationId ? "重新收集评估结果" : "重新收集执行结果"}
    </Button><span className="text-xs text-text-muted">Agent 已完成，仅补收已有输出与证据，不重新运行 Agent。</span></div>
    {collect.error && <ErrorBlock error={collect.error} />}
  </div>;
}
