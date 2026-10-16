import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@springbrand/site-block";
import { getSampleOverview, metricKeys } from "@/api-sdk/metrics-api";
import { Page, PageHeader } from "@/components/layout/page";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CodeBlock, CopyId, JsonViewer } from "@/components/ui/data-display";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import { OutputPreview, SummaryCards } from "@/features/metrics/summary";
import { AgentMetricPair } from "@/features/metrics/metric-value";
import { useProject } from "@/features/projects/use-project";
import { POLL_MS } from "@/features/runs/use-run-polling";

export function SampleResultsPage({ projectId, projectSampleId }: { projectId: string; projectSampleId: string }) {
  const navigate = useNavigate();
  const view = useProject(projectId);
  const overview = useQuery({ queryKey: metricKeys.sample(projectId, projectSampleId, []), queryFn: ({ signal }) => getSampleOverview(projectId, projectSampleId, [], signal), enabled: !!view.data, staleTime: 0, refetchInterval: view.data?.currentRun ? POLL_MS : false });
  const sample = overview.data?.projectSample;
  return (
    <Page>
      <PageHeader
        title={sample ? dataTitle(sample.data) : "用例"}
        actions={<Button asChild><Link to="/projects/$projectId/runs/new" params={{ projectId }} search={{ projectSampleId }}>重跑 / 评估</Link></Button>}
        description="用例结果 · 对照多次采样的评估输出与产物，检查结果的一致性。"
        crumbs={[{ label: "项目管理", to: "/projects" }, { label: view.data?.project.name ?? "Project", to: "/projects/$projectId", params: { projectId } }]}
      />
      {view.error && <ErrorBlock error={view.error} onRetry={() => void view.refetch()} />}
      {!view.data ? view.isPending && <LoadingBlock /> : overview.isPending ? <LoadingBlock /> : overview.error ? <ErrorBlock error={overview.error} onRetry={() => void overview.refetch()} /> : (
        <div className="flex flex-col gap-5">
          <nav aria-label="所属测试集" className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-text-muted">所属测试集</span>
            {view.data.datasets.filter((dataset) => sample?.datasetIds.includes(dataset.datasetId)).map((dataset) => (
              <Link key={dataset.datasetId} to="/projects/$projectId/datasets/$datasetId" params={{ projectId, datasetId: dataset.datasetId }}
                className="rounded-md border border-border bg-surface px-2.5 py-1 text-text-strong hover:bg-surface-hover">{dataset.name}</Link>
            ))}
          </nav>
          <SummaryCards summary={overview.data.summary}>
          <Card>
            <CardHeader title={`采样（${overview.data.samplings.length}）`} description="点击采样查看评估 Agent 的原始结果、产物证据和 Agent 会话。" />
            <DataTable
              rows={overview.data.samplings}
              rowKey={(row) => row.samplingId}
              onRowClick={(row) => void navigate({ to: "/projects/$projectId/samplings/$samplingId", params: { projectId, samplingId: row.samplingId } })}
              columns={[
                { key: "id", header: "采样", cell: (row) => <CopyId value={row.samplingId} /> },
                { key: "status", header: "执行", cell: (row) => <StatusBadge status={row.execution.status} />, sortValue: (row) => row.execution.status },
                { key: "output", header: "评估输出", cell: (row) => <OutputPreview outputs={row.summary.evaluationOutputs} /> },
                { key: "artifacts", header: "产物", align: "right", cell: (row) => row.artifactCount },
                { key: "units", header: "积分", align: "right", cell: (row) => <AgentMetricPair execution={row.summary.executionAgent.costs.chargedUnits} evaluation={row.summary.evaluationAgents.costs.chargedUnits} /> },
              ]}
            />
          </Card>
          </SummaryCards>
          <details className="rounded-[var(--radius-card)] border border-border bg-surface">
            <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-text-strong">输入与评估要求</summary>
            <div className="grid gap-4 border-t border-border p-4 lg:grid-cols-2">
              <Card><CardHeader title="执行提示词" /><CardBody><CodeBlock value={sample!.data.userPrompt} maxHeight="16rem" /></CardBody></Card>
              <Card><CardHeader title="评估提示词" /><CardBody>{sample!.data.evalPrompt ? <CodeBlock value={sample!.data.evalPrompt} maxHeight="16rem" /> : <p className="text-sm text-text-muted">无</p>}</CardBody></Card>
              <div className="lg:col-span-2"><Card><CardHeader title="样本数据" /><CardBody><JsonViewer value={sample!.data} expandLevels={1} /></CardBody></Card></div>
            </div>
          </details>
        </div>
      )}
    </Page>
  );
}
