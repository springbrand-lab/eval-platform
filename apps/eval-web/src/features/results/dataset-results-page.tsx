import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { getDatasetOverview, metricKeys } from "@/api-sdk/metrics-api";
import { getProject, projectKeys } from "@/api-sdk/projects-api";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import { OutputPreview, SummaryCards } from "@/features/metrics/summary";
import { formatNumber, formatPercent } from "@/lib/format";

export function DatasetResultsPage({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const navigate = useNavigate();
  const view = useQuery({ queryKey: projectKeys.detail(projectId), queryFn: ({ signal }) => getProject(projectId, signal) });
  const overview = useQuery({ queryKey: metricKeys.dataset(projectId, datasetId, []), queryFn: ({ signal }) => getDatasetOverview(projectId, datasetId, [], signal) });
  const samples = new Map((view.data?.projectSamples ?? []).map((sample) => [sample.projectSampleId, sample]));
  return (
    <Page>
      <PageHeader
        title={overview.data?.dataset.name ?? "测试集"}
        crumbs={[{ label: "Project", to: "/projects" }, { label: view.data?.project.name ?? "Project", to: "/projects/$projectId", params: { projectId } }]}
      />
      {overview.isPending ? <LoadingBlock /> : overview.error ? <ErrorBlock error={overview.error} /> : (
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
                { key: "units", header: "积分", align: "right", cell: (row) => formatNumber((row.summary.executionAgent.costs.chargedUnits.value ?? 0) + (row.summary.evaluationAgents.costs.chargedUnits.value ?? 0)) },
              ]}
            />
          </Card>
        </div>
      )}
    </Page>
  );
}
