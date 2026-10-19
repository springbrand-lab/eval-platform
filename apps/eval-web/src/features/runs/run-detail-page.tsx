import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCw, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { getProjectOverview, metricKeys } from "@/api-sdk/metrics-api";
import { listRunEvaluations, runKeys, syncRunScores } from "@/api-sdk/runs-api";
import type { SamplingStageState } from "@eval-platform/eval-contracts";
import type { EvaluationRecord, RunEvaluation } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { formatDateTime, OPERATION_LABELS } from "@/lib/format";
import { OutputFields } from "@/features/metrics/summary";
import { ResourceMetrics, stageStatusFor } from "@/features/metrics/resource-metrics";
import { isFinished, isStageInProgress, isStopping, runPhaseLabel, stageInProgressCount, stageProgressLabel } from "./run-status";
import { StageHint } from "./stage-hint";
import { POLL_MS, useRun } from "./use-run-polling";
import { useProject } from "@/features/projects/use-project";
import { StopRunDialog, type StopRunTarget } from "./stop-run-dialog";

export function ScoreSyncBadge({ record }: { record: EvaluationRecord }) {
  if (!record.scoreSync) return <span className="text-text-muted">暂无同步记录</span>;
  return record.scoreSync.status === "synced"
    ? <Badge tone="success">已同步</Badge>
    : <span title={record.scoreSync.lastError}><Badge tone="danger">同步失败</Badge></span>;
}

function RunEvaluationStatus({ execution, evaluation }: { execution: SamplingStageState; evaluation: SamplingStageState }) {
  // Only an in-progress stage relabels the badge; resource collection after a terminal status is a side hint.
  const executionLabel = isStageInProgress(execution.status) ? stageProgressLabel("execution", execution) : undefined;
  const evaluationLabel = isStageInProgress(evaluation.status) ? stageProgressLabel("evaluation", evaluation) : undefined;
  const label = executionLabel ?? evaluationLabel;
  const activeStatus = executionLabel === undefined ? evaluation.status : execution.status;
  const status = label === undefined && evaluation.status === "queued" && execution.status !== "succeeded" ? execution.status : activeStatus;
  return <span className="inline-flex flex-wrap items-center gap-1.5"><StatusBadge status={status} label={label} />
    {label === undefined && (execution.resourcesPending
      ? <StageHint stage="execution" state={execution} />
      : <StageHint stage="evaluation" state={evaluation} />)}</span>;
}

export function RunDetailPage({ projectId, runId }: { projectId: string; runId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const view = useProject(projectId);
  const run = useRun(projectId, runId);
  const active = !!run.data && !isFinished(run.data.run.status);
  const overview = useQuery({
    queryKey: metricKeys.project(projectId, [runId]),
    queryFn: ({ signal }) => getProjectOverview(projectId, [runId], signal),
    enabled: !!view.data, staleTime: 0,
    refetchInterval: active ? POLL_MS : false,
  });
  const evaluations = useQuery({
    queryKey: runKeys.evaluations(projectId, runId),
    queryFn: ({ signal }) => listRunEvaluations(projectId, runId, signal),
    enabled: !!view.data, staleTime: 0,
    refetchInterval: active ? POLL_MS : false,
  });
  const [stopTarget, setStopTarget] = useState<StopRunTarget | null>(null);
  const sync = useMutation({
    mutationFn: () => syncRunScores(projectId, runId),
    onSuccess: async (summary) => {
      if (summary.failed > 0) toast.error(`${summary.failed} 个分数仍未同步成功`);
      else toast.success(`已同步 ${summary.synced} 个分数`);
      await queryClient.invalidateQueries({ queryKey: runKeys.evaluations(projectId, runId) });
    },
  });
  const snapshot = run.data?.run;
  const records = evaluations.data?.evaluations ?? [];
  const unsynced = records.filter((record) => record.status.status === "succeeded" && record.scoreSync?.status !== "synced").length;

  return (
    <Page>
      <PageHeader compact
        title={`Run ${runId.slice(0, 8)}`}
        crumbs={[{ label: "项目管理", to: "/projects" }, { label: view.data?.project.name ?? "返回项目", to: "/projects/$projectId", params: { projectId } }]}
        meta={snapshot && <><StatusBadge status={snapshot.status} />{active && <span className="text-[13px] text-text-muted">{runPhaseLabel(snapshot)}</span>}</>}
        actions={(
          <>
            {unsynced > 0 && <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={sync.isPending} onClick={() => sync.mutate()}>同步可用分数</Button>}
            {active && !(snapshot && isStopping(snapshot)) && <Button size="sm" variant="outline-danger" icon={<Square />} onClick={() => setStopTarget({ projectId, runId })}>停止</Button>}
          </>
        )}
      />
      {view.error && <ErrorBlock error={view.error} onRetry={() => void view.refetch()} />}
      {run.isPending ? <LoadingBlock /> : run.error ? <ErrorBlock error={run.error} onRetry={() => void run.refetch()} /> : snapshot && (
        <div className="flex flex-col gap-3">
          <div aria-label="运行摘要" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-text-muted">
            <span>{OPERATION_LABELS[snapshot.operation]}</span>
            <span>采样 <strong className="font-medium text-text-strong">{snapshot.samplingIds.length}</strong></span>
            <span>评估 <strong className="font-medium text-text-strong">{snapshot.evaluationIds.length}</strong></span>
            {overview.data && <><span>执行成功 {overview.data.summary.execution.statuses.succeeded}</span><span>执行中 {stageInProgressCount(overview.data.summary.execution)}</span><span>评估成功 {overview.data.summary.evaluation.statuses.succeeded}</span><span>评估中 {stageInProgressCount(overview.data.summary.evaluation)}</span><span>有效结果 {overview.data.summary.evaluationOutputs.validation.valid}</span></>}
          </div>
          {isStopping(snapshot) && <Notice tone="warning">正在停止：正在中断已运行的 Agent，并收集已产生的结果。</Notice>}
          <Card>
            <div className="flex items-center justify-between border-b border-border px-3 py-2"><h2 className="text-xs font-semibold">评估列表</h2><span className="text-[11px] text-text-muted">点击记录查看采样结果</span></div>
            {evaluations.isPending ? <LoadingBlock /> : evaluations.error ? <div className="p-3"><ErrorBlock error={evaluations.error} /></div> : (
              <DataTable<RunEvaluation>
                rows={records}
                rowKey={(row) => row.evaluationId}
                onRowClick={(row) => void navigate({ to: "/projects/$projectId/samplings/$samplingId", params: { projectId, samplingId: row.samplingId } })}
                empty={<p className="px-3 py-4 text-xs text-text-muted">这个 Run 没有评估。</p>}
                columns={[
                  { key: "sampling", header: "采样", cell: (row) => <CopyId value={row.samplingId} /> },
                  { key: "status", header: "状态", cell: (row) => <RunEvaluationStatus execution={row.execution} evaluation={row.status} />, sortValue: (row) => row.status.status },
                  { key: "result", header: "异常信息", cell: (row) => <span className="line-clamp-2 max-w-xl text-text-muted">{row.status.lastError ?? "—"}</span> },
                  { key: "sync", header: "Langfuse", cell: (row) => <ScoreSyncBadge record={row} /> },
                  { key: "attempts", header: "尝试", align: "right", cell: (row) => row.attempts.length },
                ]}
              />
            )}
          </Card>
          {overview.error && <ErrorBlock error={overview.error} onRetry={() => void overview.refetch()} />}
          {overview.data && <>
            <details className="rounded-lg border border-border bg-surface">
              <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium">评估指标概览<span className="ml-3 font-normal text-text-muted">有效 {overview.data.summary.evaluationOutputs.validation.valid} · 无效 {overview.data.summary.evaluationOutputs.validation.invalid} · 未获得 {overview.data.summary.evaluationOutputs.validation.unavailable}</span></summary>
              <div className="border-t border-border p-3"><OutputFields outputs={overview.data.summary.evaluationOutputs} /></div>
            </details>
            {([
              ["执行 Agent", overview.data.summary.executionAgent, overview.data.summary.execution],
              ["评估 Agent", overview.data.summary.evaluationAgents, overview.data.summary.evaluation],
            ] as const).map(([title, statistics, stage]) => <details key={title} className="rounded-lg border border-border bg-surface">
              <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium">{title} · 资源统计<span className="ml-3 font-normal text-text-muted">已结束 {stage.terminalRecords} / {stage.records}</span></summary>
              <div className="border-t border-border p-3"><ResourceMetrics statistics={statistics} distribution={statistics.distribution} durations={stage} stageStatus={stageStatusFor(stage)} /></div>
            </details>)}
          </>}
          <details className="rounded-lg border border-border bg-surface">
            <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium">运行信息</summary>
            <dl className="flex flex-wrap gap-x-8 gap-y-3 border-t border-border p-3 text-xs"><div><dt className="mb-1 text-text-muted">Run ID</dt><dd><CopyId value={snapshot.runId} /></dd></div><div><dt className="mb-1 text-text-muted">Eval SP commit</dt><dd><CopyId value={snapshot.sourceCommit} /></dd></div></dl>
          </details>
          <p className="text-[11px] text-text-faint">
            最后更新 {formatDateTime(new Date(run.dataUpdatedAt).toISOString())}
            {active && "，每 5 秒自动刷新"}
          </p>
        </div>
      )}
      <StopRunDialog target={stopTarget} onClose={() => setStopTarget(null)} />
    </Page>
  );
}
