import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { getSampleOverview, metricKeys } from "@/api-sdk/metrics-api";
import { getProject, projectKeys } from "@/api-sdk/projects-api";
import { Page, PageHeader } from "@/components/layout/page";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CodeBlock, CopyId, ScoreBar } from "@/components/ui/data-display";
import { ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { dataTitle } from "@/features/datasets/dataset-detail-page";
import { scoreField, SummaryCards } from "@/features/metrics/summary";
import { formatNumber } from "@/lib/format";

export function SampleResultsPage({ projectId, projectSampleId }: { projectId: string; projectSampleId: string }) {
  const navigate = useNavigate();
  const view = useQuery({ queryKey: projectKeys.detail(projectId), queryFn: ({ signal }) => getProject(projectId, signal) });
  const overview = useQuery({ queryKey: metricKeys.sample(projectId, projectSampleId, []), queryFn: ({ signal }) => getSampleOverview(projectId, projectSampleId, [], signal) });
  const sample = overview.data?.projectSample;
  return (
    <Page>
      <PageHeader
        title={sample ? dataTitle(sample.data) : "用例"}
        crumbs={[{ label: "Project", to: "/projects" }, { label: view.data?.project.name ?? "Project", to: "/projects/$projectId", params: { projectId } }]}
      />
      {overview.isPending ? <LoadingBlock /> : overview.error ? <ErrorBlock error={overview.error} /> : (
        <div className="flex flex-col gap-5">
          <SummaryCards summary={overview.data.summary} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="userPrompt" />
              <CardBody><CodeBlock value={sample!.data.userPrompt} maxHeight="16rem" /></CardBody>
            </Card>
            <Card>
              <CardHeader title="evalPrompt" />
              <CardBody>{sample!.data.evalPrompt ? <CodeBlock value={sample!.data.evalPrompt} maxHeight="16rem" /> : <p className="text-sm text-text-muted">无</p>}</CardBody>
            </Card>
          </div>
          <Card>
            <CardHeader title={`采样（${overview.data.samplings.length}）`} />
            <DataTable
              rows={overview.data.samplings}
              rowKey={(row) => row.samplingId}
              onRowClick={(row) => void navigate({ to: "/projects/$projectId/samplings/$samplingId", params: { projectId, samplingId: row.samplingId } })}
              columns={[
                { key: "id", header: "采样", cell: (row) => <CopyId value={row.samplingId} /> },
                { key: "status", header: "执行", cell: (row) => <StatusBadge status={row.execution.status} /> },
                { key: "score", header: "分数", cell: (row) => <ScoreBar value={scoreField(row.summary.numericOutputs)?.summary.mean} /> },
                { key: "artifacts", header: "产物", align: "right", cell: (row) => row.artifactCount },
                { key: "units", header: "积分", align: "right", cell: (row) => formatNumber((row.summary.executionAgent.costs.chargedUnits.value ?? 0) + (row.summary.evaluationAgents.costs.chargedUnits.value ?? 0)) },
              ]}
            />
          </Card>
        </div>
      )}
    </Page>
  );
}
