import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCw, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { getProjectOverview, metricKeys } from "@/api-sdk/metrics-api";
import { getProject, projectKeys } from "@/api-sdk/projects-api";
import { listRunEvaluations, runKeys, stopRun, syncRunScores } from "@/api-sdk/runs-api";
import type { EvaluationRecord } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId, ProgressBar, ScoreBar } from "@/components/ui/data-display";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";
import { formatDateTime, OPERATION_LABELS } from "@/lib/format";
import { SummaryCards } from "@/features/metrics/summary";
import { isFinished, runPhaseLabel } from "./run-status";
import { POLL_MS, useRun } from "./use-run-polling";

export function ScoreSyncBadge({ record }: { record: EvaluationRecord }) {
  if (!record.scoreSync) return record.output?.score === undefined ? <span className="text-text-muted">—</span> : <Badge>未同步</Badge>;
  return record.scoreSync.status === "synced"
    ? <Badge tone="success">已同步</Badge>
    : <span title={record.scoreSync.lastError}><Badge tone="danger">同步失败</Badge></span>;
}

export function RunDetailPage({ projectId, runId }: { projectId: string; runId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const view = useQuery({ queryKey: projectKeys.detail(projectId), queryFn: ({ signal }) => getProject(projectId, signal) });
  const run = useRun(projectId, runId);
  const active = !!run.data && !isFinished(run.data.run.status);
  const overview = useQuery({
    queryKey: metricKeys.project(projectId, [runId]),
    queryFn: ({ signal }) => getProjectOverview(projectId, [runId], signal),
    refetchInterval: active ? POLL_MS : false,
  });
  const evaluations = useQuery({
    queryKey: runKeys.evaluations(projectId, runId),
    queryFn: ({ signal }) => listRunEvaluations(projectId, runId, signal),
    refetchInterval: active ? POLL_MS : false,
  });
  const [stopping, setStopping] = useState(false);
  const stop = useMutation({
    mutationFn: () => stopRun(projectId, runId),
    onSuccess: async () => {
      toast.success("已请求停止");
      setStopping(false);
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });
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
  const unsynced = records.filter((record) => record.output?.score !== undefined && record.scoreSync?.status !== "synced").length;

  return (
    <Page>
      <PageHeader
        title={`Run ${runId.slice(0, 8)}`}
        crumbs={[{ label: "Project", to: "/projects" }, { label: view.data?.project.name ?? "Project", to: "/projects/$projectId", params: { projectId } }]}
        meta={snapshot && <><StatusBadge status={snapshot.status} />{active && <span className="text-[13px] text-text-muted">{runPhaseLabel(snapshot)}</span>}</>}
        actions={(
          <>
            {unsynced > 0 && <Button icon={<RefreshCw />} loading={sync.isPending} onClick={() => sync.mutate()}>补同步 {unsynced} 个分数</Button>}
            {active && !snapshot?.stopRequested && <Button variant="outline-danger" icon={<Square />} onClick={() => setStopping(true)}>停止</Button>}
          </>
        )}
      />
      {run.isPending ? <LoadingBlock /> : run.error ? <ErrorBlock error={run.error} /> : snapshot && (
        <div className="flex flex-col gap-5">
          <Card>
            <CardBody className="grid gap-x-8 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { label: "操作", value: OPERATION_LABELS[snapshot.operation] },
                { label: "采样 / 评估", value: `${snapshot.samplingIds.length} / ${snapshot.evaluationIds.length}` },
                { label: "Eval SP commit", value: <CopyId value={snapshot.sourceCommit} length={10} /> },
                { label: "Run ID", value: <CopyId value={snapshot.runId} length={13} /> },
              ].map((item) => (
                <div key={item.label} className="min-w-0">
                  <p className="text-xs text-text-muted">{item.label}</p>
                  <div className="mt-1 text-[13px] font-semibold text-text-strong">{item.value}</div>
                </div>
              ))}
              {overview.data && (
                <div className="sm:col-span-2 xl:col-span-4">
                  <ProgressBar
                    total={overview.data.summary.counts.samplings + overview.data.summary.counts.evaluations}
                    segments={[
                      { label: "执行成功", value: overview.data.summary.execution.statuses.succeeded, tone: "success" },
                      { label: "评估成功", value: overview.data.summary.evaluation.statuses.succeeded, tone: "success" },
                      { label: "进行中", value: (["running", "starting", "retrying"] as const).reduce((sum, key) => sum + overview.data.summary.execution.statuses[key] + overview.data.summary.evaluation.statuses[key], 0), tone: "warning" },
                      { label: "排队", value: overview.data.summary.execution.statuses.queued + overview.data.summary.evaluation.statuses.queued, tone: "neutral" },
                      { label: "失败", value: overview.data.summary.execution.statuses.failed + overview.data.summary.evaluation.statuses.failed, tone: "danger" },
                    ]}
                  />
                </div>
              )}
            </CardBody>
          </Card>
          {snapshot.stopRequested && !isFinished(snapshot.status) && <Notice tone="warning">正在停止：正在中断已运行的 Agent，并收集已产生的结果。</Notice>}
          {overview.data && <SummaryCards summary={overview.data.summary} />}
          <Card>
            <CardHeader title={`评估（${records.length}）`} />
            {evaluations.isPending ? <LoadingBlock /> : evaluations.error ? <div className="p-4"><ErrorBlock error={evaluations.error} /></div> : (
              <DataTable<EvaluationRecord>
                rows={records}
                rowKey={(row) => row.evaluationId}
                onRowClick={(row) => void navigate({ to: "/projects/$projectId/samplings/$samplingId", params: { projectId, samplingId: row.samplingId } })}
                empty={<p className="px-4 py-6 text-sm text-text-muted">这个 Run 没有评估。</p>}
                columns={[
                  { key: "sampling", header: "采样", cell: (row) => <CopyId value={row.samplingId} /> },
                  { key: "status", header: "状态", cell: (row) => <StatusBadge status={row.status.status} />, sortValue: (row) => row.status.status },
                  { key: "score", header: "分数", cell: (row) => <ScoreBar value={row.output?.score} />, sortValue: (row) => row.output?.score ?? -1 },
                  { key: "reason", header: "理由", cell: (row) => <span className="line-clamp-2 max-w-xl text-text-muted">{row.output?.reason ?? row.status.lastError ?? "—"}</span> },
                  { key: "sync", header: "Langfuse", cell: (row) => <ScoreSyncBadge record={row} /> },
                  { key: "attempts", header: "尝试", align: "right", cell: (row) => row.attempts.length },
                ]}
              />
            )}
          </Card>
          <p className="text-xs text-text-faint">
            最后更新 {formatDateTime(new Date(run.dataUpdatedAt).toISOString())}
            {active && "，每 5 秒自动刷新"}
          </p>
        </div>
      )}
      <ConfirmDialog open={stopping} onClose={() => setStopping(false)} onConfirm={() => stop.mutate()} loading={stop.isPending} danger
        title="停止 Run" description="中断正在运行的 Agent，不再开始新的采样和评估。已完成的结果保留。" confirmLabel="停止" />
    </Page>
  );
}
