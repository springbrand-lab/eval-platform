import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { listProjects, projectKeys } from "@/api-sdk/projects-api";
import type { Project } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";
import { formatDateTime } from "@/lib/format";

export function ProjectsPage() {
  const navigate = useNavigate();
  const projects = useQuery({ queryKey: projectKeys.list(), queryFn: ({ signal }) => listProjects(signal) });
  return (
    <Page>
      <PageHeader
        title="Project"
        description="一个 Project 固定一组用例、被测 Agent 和评估计划，可以反复发起 Run 并对比结果。"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => void navigate({ to: "/projects/new" })}>新建 Project</Button>}
      />
      <Card>
        {projects.isPending ? <LoadingBlock /> : projects.error ? <div className="p-4"><ErrorBlock error={projects.error} onRetry={() => void projects.refetch()} /></div> : (
          <DataTable<Project>
            rows={projects.data}
            rowKey={(row) => row.projectId}
            searchText={(row) => `${row.name} ${row.description ?? ""}`}
            onRowClick={(row) => void navigate({ to: "/projects/$projectId", params: { projectId: row.projectId } })}
            empty={<EmptyState title="还没有 Project" description="先准备测试集、评分格式和 Agent，再新建 Project。"
              action={<Button variant="primary" onClick={() => void navigate({ to: "/projects/new" })}>新建 Project</Button>} />}
            columns={[
              { key: "name", header: "名称", cell: (row) => <span className="font-semibold">{row.name}</span>, sortValue: (row) => row.name },
              { key: "description", header: "说明", cell: (row) => <span className="line-clamp-1 text-text-muted">{row.description || "—"}</span> },
              { key: "branch", header: "SP 分支", cell: (row) => <span className="font-mono text-xs">{row.sourceBranch}</span> },
              { key: "createdAt", header: "创建时间", cell: (row) => formatDateTime(row.createdAt), sortValue: (row) => row.createdAt },
              { key: "id", header: "ID", cell: (row) => <CopyId value={row.projectId} /> },
            ]}
          />
        )}
      </Card>
    </Page>
  );
}
