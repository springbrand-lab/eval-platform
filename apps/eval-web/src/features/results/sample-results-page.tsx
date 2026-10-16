import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
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
        actions={<Link className="link text-sm font-semibold" to="/projects/$projectId/runs/new" params={{ projectId }} search={{ projectSampleId }}>重跑 / 评估</Link>}
        crumbs={[{ label: "Project", to: "/projects" }, { label: view.data?.project.name ?? "Project", to: "/projects/$projectId", params: { projectId } }]}
      />
      {view.error && <ErrorBlock error={view.error} onRetry={() => void view.refetch()} />}
      {!view.data ? view.isPending && <LoadingBlock /> : overview.isPending ? <LoadingBlock /> : overview.error ? <ErrorBlock error={overview.error} onRetry={() => void overview.refetch()} /> : (
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
          <Card><CardHeader title="样本数据" /><CardBody><JsonViewer value={sample!.data} /></CardBody></Card>
          <Card>
            <CardHeader title={`采样（${overview.data.samplings.length}）`} />
            <DataTable
              rows={overview.data.samplings}
              rowKey={(row) => row.samplingId}
              onRowClick={(row) => void navigate({ to: "/projects/$projectId/samplings/$samplingId", params: { projectId, samplingId: row.samplingId } })}
              columns={[
                { key: "id", header: "采样", cell: (row) => <CopyId value={row.samplingId} /> },
                { key: "status", header: "执行", cell: (row) => <StatusBadge status={row.execution.status} /> },
                { key: "output", header: "评估输出", cell: (row) => <OutputPreview outputs={row.summary.evaluationOutputs} /> },
                { key: "artifacts", header: "产物", align: "right", cell: (row) => row.artifactCount },
                { key: "units", header: "积分", align: "right", cell: (row) => <AgentMetricPair execution={row.summary.executionAgent.costs.chargedUnits} evaluation={row.summary.evaluationAgents.costs.chargedUnits} /> },
              ]}
            />
          </Card>
        </div>
      )}
    </Page>
  );
}
