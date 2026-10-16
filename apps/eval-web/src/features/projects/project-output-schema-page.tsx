import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getProjectOutputSchema, projectKeys } from "@/api-sdk/projects-api";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardBody, CardHeader, DescriptionList } from "@/components/ui/card";
import { CopyId, JsonViewer } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { useProject } from "./use-project";

export function ProjectOutputSchemaPage({ projectId }: { projectId: string }) {
  const view = useProject(projectId);
  const schema = useQuery({ queryKey: projectKeys.outputSchema(projectId, view.data?.evaluation?.digest ?? null),
    queryFn: ({ signal }) => getProjectOutputSchema(projectId, signal), enabled: !!view.data });
  return <Page>
    <PageHeader title="评估结果格式" crumbs={[{ label: "项目管理", to: "/projects" },
      { label: view.data?.project.name ?? "项目", to: "/projects/$projectId", params: { projectId } }]} />
    {view.error ? <ErrorBlock error={view.error} onRetry={() => void view.refetch()} />
      : schema.error ? <ErrorBlock error={schema.error} onRetry={() => void schema.refetch()} />
      : schema.isPending ? <LoadingBlock /> : !schema.data ? <EmptyState title="还没有评估结果格式"
        action={<Link className="link" to="/projects/$projectId/evaluation-plan" params={{ projectId }}>填写评估计划</Link>} />
      : <Card><CardHeader title="JSON Schema" /><CardBody className="flex flex-col gap-4">
        <DescriptionList items={[
          { label: "Schema ID", value: <CopyId value={schema.data.reference.outputSchemaId} /> },
          { label: "摘要", value: <CopyId value={schema.data.reference.digest} length={16} /> },
        ]} />
        <JsonViewer value={schema.data.content} />
      </CardBody></Card>}
  </Page>;
}
