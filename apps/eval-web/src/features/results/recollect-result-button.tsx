import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isPendingSamplingStatus, type RecollectTarget, type SamplingStageState } from "@eval-platform/eval-contracts";
import { toast } from "sonner";
import { getProjectRun, recollectResult } from "@/api-sdk/runs-api";
import { getSamplingDetail } from "@/api-sdk/metrics-api";
import { projectKeys } from "@/api-sdk/projects-api";
import type { ResourceCollections } from "@/api-sdk/types";
import { Button } from "@/components/ui/button";
import { ErrorBlock } from "@/components/ui/feedback";
import { refreshProjectResults } from "@/features/projects/use-project";
import { ResourceCollectionNotes } from "@/features/metrics/resource-metrics";
import { RESOURCES_PENDING_LABEL, resourceCollectionGap, unfinalizedResourceCount } from "@/features/metrics/resource-collection";

/** Queue one collection-only recovery, await the persisted job, then verify the refreshed stage. */
function useRecollect({ projectId, samplingId, evaluationId, target }: {
  projectId: string; samplingId: string; evaluationId?: string; target: RecollectTarget;
}) {
  const client = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const kind = evaluationId ? "evaluations" : "samplings";
      const id = evaluationId ?? samplingId;
      const accepted = await recollectResult(projectId, kind, id, target);
      if (!accepted.queued) return "done" as const;
      await client.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
      const deadline = Date.now() + 120_000;
      while (true) {
        const { run } = await getProjectRun(projectId, accepted.runId);
        if (!isPendingSamplingStatus(run.status)) break;
        if (Date.now() >= deadline) throw new Error(target === "output" ? "后台仍在收集结果，可关闭此页面，稍后查看状态。" : "后台仍在补采资源，可关闭此页面，稍后查看状态。");
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const detail = await getSamplingDetail(projectId, samplingId);
      const agent = evaluationId ? detail.evaluations.find((item) => item.record.evaluationId === evaluationId)?.agent : detail.subject;
      const state = agent?.stage;
      if (target === "output") {
        if (state?.status !== "succeeded") throw new Error(state?.lastError ?? "本次收集未成功，可查看错误后再次尝试。");
        return "done" as const;
      }
      // The Run settles before its resource wait does.
      if (state?.resourcesPending) return "scheduled" as const;
      const collections = agent?.resources.collections;
      if (collections && resourceCollectionGap(collections) > 0) {
        throw new Error(`资源仍未完整采集：失败 ${collections.failed} 个，尚未采集 ${collections.uncollected} 个，未定稿 ${unfinalizedResourceCount(collections)} 个，可稍后再次尝试。`);
      }
      return "done" as const;
    },
    onSuccess: (outcome) => {
      if (outcome === "scheduled") toast.info("后台仍在补采资源，可关闭此页面，稍后查看状态。");
      else toast.success(target === "resources" ? "资源已重新采集"
        : evaluationId ? "评估结果已重新收集" : "执行产物与完整轨迹已重新收集；未执行的评估需另行发起");
    },
    onSettled: async () => {
      await Promise.all([refreshProjectResults(client, projectId), client.invalidateQueries({ queryKey: projectKeys.detail(projectId) })]);
    },
  });
}

export function RecollectResultButton({ projectId, samplingId, evaluationId, stage, resources, eligible, busy }: {
  projectId: string; samplingId: string; evaluationId?: string; stage: SamplingStageState;
  resources: ResourceCollections;
  eligible: boolean; busy: boolean;
}) {
  const output = useRecollect({ projectId, samplingId, evaluationId, target: "output" });
  const resourceCollect = useRecollect({ projectId, samplingId, evaluationId, target: "resources" });
  const outputPending = output.isPending || !!stage.collectionPending;
  const resourcesPending = resourceCollect.isPending || !!stage.resourcesPending;
  const anyPending = outputPending || resourcesPending;
  const showOutput = stage.status === "failed" || outputPending || !!output.error;
  // An active stage still collects its own resources.
  const stageFinished = stage.status === "succeeded" || stage.status === "failed";
  const showResources = (stageFinished && resourceCollectionGap(resources) > 0) || resourcesPending || !!resourceCollect.error;
  if (!eligible || (!showOutput && !showResources)) return null;
  return <div data-testid="recollect-result" className="flex flex-col gap-2 rounded-lg border border-border p-3">
    {showOutput && <div className="flex flex-wrap items-center gap-3"><Button data-testid="recollect-output" loading={outputPending} disabled={busy || anyPending} onClick={() => output.mutate()}>
      {outputPending ? "正在收集结果" : evaluationId ? "重新收集评估结果" : "重新收集执行结果"}
    </Button><span className="text-xs text-text-muted">Agent 已完成，仅补收已有输出与证据，不重新运行 Agent。</span></div>}
    {output.error && <ErrorBlock error={output.error} />}
    {showResources && <div className="flex flex-wrap items-center gap-3"><Button data-testid="recollect-resources" loading={resourcesPending} disabled={busy || anyPending} onClick={() => resourceCollect.mutate()}>
      {resourcesPending ? RESOURCES_PENDING_LABEL : "重新采集资源"}
    </Button><span className="text-xs text-text-muted">仅重新读取该 Agent 的用量、计费与遥测，不重新运行 Agent。</span>
      <ResourceCollectionNotes collections={resources} resourcesPending={!!stage.resourcesPending} /></div>}
    {stage.resourcesPending?.lastError && !resourceCollect.error && <p className="break-words text-xs text-text-muted">上次资源采集错误：{stage.resourcesPending.lastError}</p>}
    {resourceCollect.error && <ErrorBlock error={resourceCollect.error} />}
  </div>;
}
