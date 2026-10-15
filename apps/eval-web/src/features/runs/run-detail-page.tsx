import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ExternalLink, RefreshCw, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { getProjectOverview, metricKeys } from "@/api-sdk/metrics-api";
import { getProject, projectKeys } from "@/api-sdk/projects-api";
import { listRunEvaluations, runKeys, stopRun, syncRunScores } from "@/api-sdk/runs-api";
import type { EvaluationRecord } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, DescriptionList } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId, ScoreBar } from "@/components/ui/data-display";
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
        actions={(
          <>
            {unsynced > 0 && <Button icon={<RefreshCw className="size-4" />} loading={sync.isPending} onClick={() => sync.mutate()}>补同步 {unsynced} 个分数</Button>}
            {active && !snapshot?.stopRequested && <Button variant="danger" icon={<Square className="size-4" />} onClick={() => setStopping(true)}>停止</Button>}
          </>
        )}
      />
      {run.isPending ? <LoadingBlock /> : run.error ? <ErrorBlock error={run.error} /> : snapshot && (
        <div className="flex flex-col gap-5">
          <Card>
            <CardBody>
              <DescriptionList items={[
                { label: "状态", value: <span className="flex items-center gap-2"><StatusBadge status={snapshot.status} />{active && <span className="text-text-muted">{runPhaseLabel(snapshot)}</span>}</span> },
                { label: "操作", value: OPERATION_LABELS[snapshot.operation] },
                { label: "Eval SP commit", value: <span className="font-mono text-xs">{snapshot.sourceCommit}</span> },
                { label: "采样 / 评估", value: `${snapshot.samplingIds.length} / ${snapshot.evaluationIds.length}` },
                { label: "Run ID", value: <CopyId value={snapshot.runId} length={36} /> },
              ]} />
            </CardBody>
          </Card>
          {snapshot.stopRequested && !isFinished(snapshot.status) && <Notice tone="warning">正在停止：正在中断已运行的 Agent，并收集已产生的结果。</Notice>}
          {overview.data && <SummaryCards summary={overview.data.summary} />}
          <Card>
            <CardHeader title={`评估（${records.length}）`} description="评委对每个采样的打分；分数同时写到 Langfuse 中被测 Agent 的会话上" />
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
          <p className="text-xs text-text-muted">
            最后更新 {formatDateTime(new Date(run.dataUpdatedAt).toISOString())}
            {active && "，每 5 秒自动刷新"}
          </p>
          <Link to="/projects/$projectId" params={{ projectId }} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            返回 Project <ExternalLink className="size-3.5" />
          </Link>
        </div>
      )}
      <ConfirmDialog open={stopping} onClose={() => setStopping(false)} onConfirm={() => stop.mutate()} loading={stop.isPending} danger
        title="停止 Run" description="已在执行的 Agent 会被中断，未开始的采样和评估不再执行。已完成的结果会保留。" confirmLabel="停止" />
    </Page>
  );
}
