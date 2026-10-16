import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ClipboardCheck, Play, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { getProjectOverview, metricKeys } from "@/api-sdk/metrics-api";
import { deleteProject, projectKeys } from "@/api-sdk/projects-api";
import type { ProjectView } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, DescriptionList, SectionLabel } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId, ProgressBar } from "@/components/ui/data-display";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState, ErrorBlock, LoadingBlock, Spinner } from "@/components/ui/feedback";
import { ActionMenu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { formatDateTime, formatDuration, formatNumber, formatPercent, OPERATION_LABELS } from "@/lib/format";
import { OutputPreview, SummaryCards } from "@/features/metrics/summary";
import { runPhaseLabel } from "@/features/runs/run-status";
import { POLL_MS, useRun } from "@/features/runs/use-run-polling";
import { useProject } from "./use-project";
import { StopRunDialog, type StopRunTarget } from "@/features/runs/stop-run-dialog";

function CurrentRunBanner({ projectId, current, onStop }: { projectId: string; current: ProjectView["currentRun"]; onStop: (target: StopRunTarget) => void }) {
  const runId = current?.runId;
  const run = useRun(projectId, runId);
  const overview = useQuery({
    queryKey: metricKeys.project(projectId, runId ? [runId] : []),
    queryFn: ({ signal }) => getProjectOverview(projectId, [runId!], signal),
    enabled: !!runId,
    refetchInterval: runId ? POLL_MS : false,
  });
  if (!runId) return null;
  const snapshot = run.data?.run;
  const summary = overview.data?.summary;
  const execution = summary?.execution.statuses;
  const evaluation = summary?.evaluation.statuses;
  return (
    <Card className="border-warning/30">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Spinner className="text-warning" />
          <span className="text-sm font-semibold text-text-strong">{snapshot ? runPhaseLabel(snapshot) : "运行中"}</span>
          {snapshot && <span className="text-[13px] text-text-muted">{OPERATION_LABELS[snapshot.operation]}</span>}
        </div>
        {execution && evaluation && (
          <div className="min-w-64 flex-1">
            <ProgressBar
              total={summary.counts.samplings + summary.counts.evaluations}
              segments={[
                { label: "执行成功", value: execution.succeeded, tone: "success" },
                { label: "评估成功", value: evaluation.succeeded, tone: "success" },
                { label: "进行中", value: execution.running + execution.starting + execution.retrying + evaluation.running + evaluation.starting + evaluation.retrying, tone: "warning" },
                { label: "排队", value: execution.queued + evaluation.queued, tone: "neutral" },
                { label: "失败", value: execution.failed + evaluation.failed, tone: "danger" },
              ]}
            />
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId }}>
            <Button size="sm" icon={<ArrowRight />}>查看进度</Button>
          </Link>
          {!current?.stopRequested && (
            <Button size="sm" variant="outline-danger" icon={<Square />} onClick={() => onStop({ projectId, runId })}>停止</Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function PlanCard({ view }: { view: ProjectView }) {
  const execution = view.execution;
  const evaluation = view.evaluation;
  const projectId = view.project.projectId;
  return (
    <Card>
      <CardHeader title="计划" />
      <CardBody className="grid gap-6 md:grid-cols-2">
        <div>
          <SectionLabel>执行</SectionLabel>
          <DescriptionList items={[
            { label: "被测 Agent", value: execution.subjectAgentConfig.name },
            { label: "执行并发", value: execution.executionConcurrency },
            { label: "重试", value: `最多 ${execution.retryPolicy.maxRestarts} 次` },
            { label: "单次超时", value: execution.harness.runtime?.timeoutMs ? formatDuration(execution.harness.runtime.timeoutMs) : "默认" },
          ]} />
        </div>
        <div>
          <SectionLabel actions={(
            <Link to="/projects/$projectId/evaluation-plan" params={{ projectId }} className="text-xs link font-semibold">
              {evaluation ? (evaluation.lockedAt ? "查看" : "修改") : "填写"}
            </Link>
          )}>
            评估
          </SectionLabel>
          {evaluation ? (
            <DescriptionList items={[
              { label: "评委 Agent", value: evaluation.plan.evaluatorAgentConfig.name },
              { label: "评估并发", value: evaluation.plan.evaluationConcurrency },
              { label: "评分 Schema", value: <Link to="/projects/$projectId/output-schema" params={{ projectId }} className="link">查看</Link> },
            ]} />
          ) : <p className="text-[13px] text-text-muted">还没有评估计划，只能执行，不能评估。</p>}
        </div>
      </CardBody>
    </Card>
  );
}

function RunRow({ projectId, runId }: { projectId: string; runId: string }) {
  const run = useRun(projectId, runId);
  const snapshot = run.data?.run;
  return (
    <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId }}
      className="flex items-center gap-4 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0 hover:bg-surface-hover">
      {snapshot ? <StatusBadge status={snapshot.status} /> : <Spinner />}
      <span className="w-24 font-semibold text-text-strong">{snapshot ? OPERATION_LABELS[snapshot.operation] : "—"}</span>
      <span className="text-text-muted">{snapshot ? `${snapshot.samplingIds.length} 个采样 · ${snapshot.evaluationIds.length} 个评估` : ""}</span>
      <span className="ml-auto font-mono text-xs text-text-faint">{runId.slice(0, 8)}</span>
    </Link>
  );
}

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const view = useProject(projectId);
  const overview = useQuery({
    queryKey: metricKeys.project(projectId, []),
    queryFn: ({ signal }) => getProjectOverview(projectId, [], signal),
    enabled: !!view.data, staleTime: 0,
    refetchInterval: view.data?.currentRun ? 10_000 : false,
  });
  const [deleting, setDeleting] = useState(false);
  const [stopTarget, setStopTarget] = useState<StopRunTarget | null>(null);
  const remove = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: async () => {
      toast.success("已删除 Project");
      await queryClient.invalidateQueries({ queryKey: projectKeys.all });
      void navigate({ to: "/projects" });
    },
  });
  const project = view.data?.project;
  const busy = !!view.data?.currentRun;
  return (
    <Page>
      <PageHeader
        title={project?.name ?? "Project"}
        description={project?.description}
        crumbs={[{ label: "Project", to: "/projects" }]}
        meta={project && <Badge>{project.sourceBranch}</Badge>}
        actions={(
          <>
            <Button icon={<ClipboardCheck />} onClick={() => void navigate({ to: "/projects/$projectId/evaluation-plan", params: { projectId } })}>评估计划</Button>
            <Tooltip content={busy ? "当前 Run 结束后才能发起" : null}>
              <span>
                <Button variant="primary" icon={<Play />} disabled={busy}
                  onClick={() => void navigate({ to: "/projects/$projectId/runs/new", params: { projectId } })}>发起 Run</Button>
              </span>
            </Tooltip>
            <ActionMenu items={[{ label: "删除 Project", icon: <Trash2 />, danger: true, disabled: busy, onSelect: () => setDeleting(true) }]} />
          </>
        )}
      />
      {view.isPending ? <LoadingBlock /> : view.error ? <ErrorBlock error={view.error} onRetry={() => void view.refetch()} /> : (
        <div className="flex flex-col gap-5">
          <CurrentRunBanner projectId={projectId} current={view.data!.currentRun} onStop={setStopTarget} />
          {overview.data ? <SummaryCards summary={overview.data.summary} /> : overview.error ? <ErrorBlock error={overview.error} /> : <LoadingBlock rows={2} />}
          <Card>
            <CardHeader title="测试集" />
            <DataTable
              rows={overview.data?.datasets ?? []}
              rowKey={(row) => row.dataset.datasetId}
              onRowClick={(row) => void navigate({ to: "/projects/$projectId/datasets/$datasetId", params: { projectId, datasetId: row.dataset.datasetId } })}
              columns={[
                { key: "name", header: "测试集", cell: (row) => <span className="font-semibold text-text-strong">{row.dataset.name}</span> },
                { key: "samples", header: "用例", align: "right", cell: (row) => formatNumber(row.summary.counts.projectSamples) },
                { key: "samplings", header: "采样", align: "right", cell: (row) => formatNumber(row.summary.counts.samplings) },
                { key: "execution", header: "执行成功率", align: "right", cell: (row) => formatPercent(row.summary.execution.successRate) },
                { key: "evaluation", header: "评估成功率", align: "right", cell: (row) => formatPercent(row.summary.evaluation.successRate) },
                { key: "output", header: "评估输出", cell: (row) => <OutputPreview outputs={row.summary.evaluationOutputs} /> },
              ]}
            />
          </Card>
          <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
            {view.data && <PlanCard view={view.data} />}
            <Card>
              <CardHeader title="Run" />
              {(overview.data?.runIds ?? []).length === 0
                ? <EmptyState title="还没有 Run" />
                : <div>{overview.data!.runIds.map((runId) => <RunRow key={runId} projectId={projectId} runId={runId} />)}</div>}
            </Card>
          </div>
          {project && <p className="text-xs text-text-faint">创建于 {formatDateTime(project.createdAt)} · <CopyId value={project.projectId} /></p>}
        </div>
      )}
      <StopRunDialog target={stopTarget} onClose={() => setStopTarget(null)} />
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger
        title="删除 Project" description="Project 及其结果将不再显示。" confirmLabel="删除" />
    </Page>
  );
}
