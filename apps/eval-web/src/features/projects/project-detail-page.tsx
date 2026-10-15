import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ClipboardCheck, Lock, Play, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getProjectOverview, metricKeys } from "@/api-sdk/metrics-api";
import { deleteProject, getProject, projectKeys } from "@/api-sdk/projects-api";
import { runKeys, stopRun } from "@/api-sdk/runs-api";
import type { ProjectView } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, DescriptionList } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorBlock, LoadingBlock, Notice, Spinner } from "@/components/ui/feedback";
import { formatDateTime, formatDuration, formatNumber, formatPercent, OPERATION_LABELS } from "@/lib/format";
import { scoreField, SummaryCards } from "@/features/metrics/summary";
import { runPhaseLabel } from "@/features/runs/run-status";
import { useCurrentRun, useRun } from "@/features/runs/use-run-polling";

function CurrentRunBanner({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const current = useCurrentRun(projectId);
  const runId = current.data?.run?.runId;
  const run = useRun(projectId, runId);
  const [stopping, setStopping] = useState(false);
  const wasActive = useRef(false);
  // When the current Run finishes, refresh the Project and its metrics once.
  useEffect(() => {
    if (runId) wasActive.current = true;
    else if (wasActive.current && current.data) {
      wasActive.current = false;
      void queryClient.invalidateQueries({ queryKey: ["metrics", projectId] });
      void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    }
  }, [runId, current.data, projectId, queryClient]);
  const stop = useMutation({
    mutationFn: () => stopRun(projectId, runId!),
    onSuccess: async () => {
      toast.success("已请求停止");
      setStopping(false);
      await queryClient.invalidateQueries({ queryKey: runKeys.current(projectId) });
    },
  });
  if (!runId) return null;
  const snapshot = run.data?.run;
  return (
    <Notice tone="warning">
      <div className="flex flex-wrap items-center gap-3">
        <Spinner className="text-warning" />
        <span className="font-medium">{snapshot ? runPhaseLabel(snapshot) : "运行中"}</span>
        {snapshot && <span className="text-text-muted">{OPERATION_LABELS[snapshot.operation]} · {snapshot.samplingIds.length} 个采样 · {snapshot.evaluationIds.length} 个评估</span>}
        <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId }} className="font-medium text-primary hover:underline">查看进度</Link>
        {!current.data?.run?.stopRequested && (
          <Button size="sm" variant="ghost" className="ml-auto text-danger" icon={<Square className="size-3.5" />} onClick={() => setStopping(true)}>停止</Button>
        )}
      </div>
      <ConfirmDialog open={stopping} onClose={() => setStopping(false)} onConfirm={() => stop.mutate()} loading={stop.isPending} danger
        title="停止 Run" description="已在执行的 Agent 会被中断，未开始的采样和评估不再执行。已完成的结果会保留。" confirmLabel="停止" />
    </Notice>
  );
}

function PlanCard({ view }: { view: ProjectView }) {
  const execution = view.execution;
  const evaluation = view.evaluation;
  return (
    <Card>
      <CardHeader title="计划" actions={(
        <Link to="/projects/$projectId/evaluation-plan" params={{ projectId: view.project.projectId }} className="text-[13px] font-medium text-primary hover:underline">
          {evaluation ? (evaluation.lockedAt ? "查看评估计划" : "修改评估计划") : "填写评估计划"}
        </Link>
      )} />
      <CardBody className="grid gap-6 md:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-medium text-text-muted">执行计划（创建后固定）</p>
          <DescriptionList items={[
            { label: "被测 Agent", value: execution.subjectAgentConfig.name },
            { label: "执行并发", value: execution.executionConcurrency },
            { label: "重试", value: `最多 ${execution.retryPolicy.maxRestarts} 次` },
            { label: "超时", value: execution.harness.runtime?.timeoutMs ? formatDuration(execution.harness.runtime.timeoutMs) : "默认" },
          ]} />
        </div>
        <div>
          <p className="mb-2 flex items-center gap-2 text-xs font-medium text-text-muted">
            评估计划
            {evaluation?.lockedAt && <Badge tone="warning"><Lock className="size-3" />已锁定</Badge>}
          </p>
          {evaluation ? (
            <DescriptionList items={[
              { label: "评委 Agent", value: evaluation.plan.evaluatorAgentConfig.name },
              { label: "评估并发", value: evaluation.plan.evaluationConcurrency },
              { label: "评分格式", value: <CopyId value={evaluation.plan.outputSchema.outputSchemaId} /> },
              { label: "锁定时间", value: formatDateTime(evaluation.lockedAt) },
            ]} />
          ) : <p className="text-sm text-text-muted">还没有评估计划，只能执行，不能评估。</p>}
        </div>
      </CardBody>
    </Card>
  );
}

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const view = useQuery({ queryKey: projectKeys.detail(projectId), queryFn: ({ signal }) => getProject(projectId, signal) });
  const overview = useQuery({
    queryKey: metricKeys.project(projectId, []),
    queryFn: ({ signal }) => getProjectOverview(projectId, [], signal),
    refetchInterval: view.data?.currentRun ? 10_000 : false,
  });
  const [deleting, setDeleting] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: async () => {
      toast.success("已删除 Project");
      await queryClient.invalidateQueries({ queryKey: projectKeys.all });
      void navigate({ to: "/projects" });
    },
  });
  const project = view.data?.project;
  return (
    <Page>
      <PageHeader
        title={project?.name ?? "Project"}
        description={project?.description}
        crumbs={[{ label: "Project", to: "/projects" }]}
        actions={(
          <>
            <Button variant="primary" icon={<Play className="size-4" />} disabled={!!view.data?.currentRun}
              title={view.data?.currentRun ? "当前 Run 结束后才能发起新的 Run" : undefined}
              onClick={() => void navigate({ to: "/projects/$projectId/runs/new", params: { projectId } })}>发起 Run</Button>
            <Button icon={<ClipboardCheck className="size-4" />} onClick={() => void navigate({ to: "/projects/$projectId/evaluation-plan", params: { projectId } })}>评估计划</Button>
            <Button variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(true)}>删除</Button>
          </>
        )}
      />
      {view.isPending ? <LoadingBlock /> : view.error ? <ErrorBlock error={view.error} onRetry={() => void view.refetch()} /> : (
        <div className="flex flex-col gap-5">
          <CurrentRunBanner projectId={projectId} />
          {overview.data ? <SummaryCards summary={overview.data.summary} /> : overview.error ? <ErrorBlock error={overview.error} /> : <LoadingBlock rows={2} />}
          <Card>
            <CardHeader title="测试集" description="点击查看每条用例的结果" />
            <DataTable
              rows={overview.data?.datasets ?? []}
              rowKey={(row) => row.dataset.datasetId}
              onRowClick={(row) => void navigate({ to: "/projects/$projectId/datasets/$datasetId", params: { projectId, datasetId: row.dataset.datasetId } })}
              columns={[
                { key: "name", header: "测试集", cell: (row) => <span className="font-medium">{row.dataset.name}</span> },
                { key: "samples", header: "用例", align: "right", cell: (row) => formatNumber(row.summary.counts.projectSamples) },
                { key: "samplings", header: "采样", align: "right", cell: (row) => formatNumber(row.summary.counts.samplings) },
                { key: "execution", header: "执行成功率", align: "right", cell: (row) => formatPercent(row.summary.execution.successRate) },
                { key: "evaluation", header: "评估成功率", align: "right", cell: (row) => formatPercent(row.summary.evaluation.successRate) },
                { key: "score", header: "平均分", align: "right", cell: (row) => formatNumber(scoreField(row.summary.numericOutputs)?.summary.mean, 2) },
              ]}
            />
          </Card>
          {view.data && <PlanCard view={view.data} />}
          <Card>
            <CardHeader title="Run" description="仍有当前结果的 Run；被后续 Run 替换掉全部结果的不再列出" />
            <DataTable
              rows={(overview.data?.runIds ?? []).map((runId) => ({ runId }))}
              rowKey={(row) => row.runId}
              onRowClick={(row) => void navigate({ to: "/projects/$projectId/runs/$runId", params: { projectId, runId: row.runId } })}
              empty={<p className="px-4 py-6 text-sm text-text-muted">还没有 Run。</p>}
              columns={[
                { key: "runId", header: "Run", cell: (row) => <CopyId value={row.runId} length={12} /> },
                { key: "status", header: "", cell: (row) => <RunStatusCell projectId={projectId} runId={row.runId} /> },
              ]}
            />
          </Card>
        </div>
      )}
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger
        title="删除 Project" description="Project 及其结果将不再显示。有未结束的 Run 时不能删除。" confirmLabel="删除" />
    </Page>
  );
}

function RunStatusCell({ projectId, runId }: { projectId: string; runId: string }) {
  const run = useRun(projectId, runId);
  if (!run.data) return <Spinner />;
  return (
    <span className="flex items-center gap-2">
      <StatusBadge status={run.data.run.status} />
      <span className="text-text-muted">{OPERATION_LABELS[run.data.run.operation]}</span>
    </span>
  );
}
