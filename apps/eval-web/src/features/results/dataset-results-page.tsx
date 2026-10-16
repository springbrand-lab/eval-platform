import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { getDatasetOverview, metricKeys } from "@/api-sdk/metrics-api";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import { OutputPreview, SummaryCards } from "@/features/metrics/summary";
import { AgentMetricPair } from "@/features/metrics/metric-value";
import { formatNumber, formatPercent } from "@/lib/format";
import { useProject } from "@/features/projects/use-project";
import { POLL_MS } from "@/features/runs/use-run-polling";

export function DatasetResultsPage({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const navigate = useNavigate();
  const view = useProject(projectId);
  const overview = useQuery({ queryKey: metricKeys.dataset(projectId, datasetId, []), queryFn: ({ signal }) => getDatasetOverview(projectId, datasetId, [], signal), enabled: !!view.data, staleTime: 0, refetchInterval: view.data?.currentRun ? POLL_MS : false });
  const samples = new Map((view.data?.projectSamples ?? []).map((sample) => [sample.projectSampleId, sample]));
  return (
    <Page>
      <PageHeader
        title={overview.data?.dataset.name ?? "测试集"}
        actions={<Link className="link text-sm font-semibold" to="/projects/$projectId/runs/new" params={{ projectId }} search={{ datasetId }}>重跑 / 评估</Link>}
        crumbs={[{ label: "Project", to: "/projects" }, { label: view.data?.project.name ?? "Project", to: "/projects/$projectId", params: { projectId } }]}
      />
      {view.error && <ErrorBlock error={view.error} onRetry={() => void view.refetch()} />}
      {!view.data ? view.isPending && <LoadingBlock /> : overview.isPending ? <LoadingBlock /> : overview.error ? <ErrorBlock error={overview.error} onRetry={() => void overview.refetch()} /> : (
        <div className="flex flex-col gap-5">
          <SummaryCards summary={overview.data.summary} />
          <Card>
            <CardHeader title={`用例（${overview.data.projectSamples.length}）`} />
            <DataTable
              rows={overview.data.projectSamples}
              rowKey={(row) => row.projectSampleId}
              searchText={(row) => { const sample = samples.get(row.projectSampleId); return sample ? `${dataTitle(sample.data)} ${sample.data.userPrompt}` : row.projectSampleId; }}
              onRowClick={(row) => void navigate({ to: "/projects/$projectId/samples/$projectSampleId", params: { projectId, projectSampleId: row.projectSampleId } })}
              columns={[
                { key: "title", header: "用例", cell: (row) => { const sample = samples.get(row.projectSampleId); return <span className="line-clamp-2">{sample ? dataTitle(sample.data) : row.dataId}</span>; } },
                { key: "samplings", header: "采样", align: "right", cell: (row) => `${formatNumber(row.summary.counts.samplings)} / ${row.samplingCount}` },
                { key: "execution", header: "执行成功率", align: "right", cell: (row) => formatPercent(row.summary.execution.successRate), sortValue: (row) => row.summary.execution.successRate },
                { key: "output", header: "评估输出", cell: (row) => <OutputPreview outputs={row.summary.evaluationOutputs} /> },
                { key: "units", header: "积分", align: "right", cell: (row) => <AgentMetricPair execution={row.summary.executionAgent.costs.chargedUnits} evaluation={row.summary.evaluationAgents.costs.chargedUnits} /> },
              ]}
            />
          </Card>
        </div>
      )}
    </Page>
  );
}
