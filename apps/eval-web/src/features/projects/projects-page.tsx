import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, FlaskConical, Plus } from "lucide-react";
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
        title="项目管理"
        description="查看实验结果，逐层定位到测试集、用例和单次采样。"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => void navigate({ to: "/projects/new" })}>新建项目</Button>}
      />
      <Card>
        {projects.isPending ? <LoadingBlock /> : projects.error ? <div className="p-4"><ErrorBlock error={projects.error} onRetry={() => void projects.refetch()} /></div> : (
          <DataTable<Project>
            rows={projects.data}
            rowKey={(row) => row.projectId}
            searchText={(row) => `${row.name} ${row.description ?? ""}`}
            searchPlaceholder="搜索项目名称或说明"
            onRowClick={(row) => void navigate({ to: "/projects/$projectId", params: { projectId: row.projectId } })}
            empty={<EmptyState title="还没有项目"
              icon={<FlaskConical />} description="准备好数据集和 Agent 后，创建项目并开始第一次实验。"
              action={<Button variant="primary" onClick={() => void navigate({ to: "/projects/new" })}>新建项目</Button>} />}
            columns={[
              { key: "name", header: "项目", cell: (row) => <div className="min-w-48 py-1"><span className="font-semibold text-text-strong">{row.name}</span>
                <p className="mt-1 line-clamp-1 max-w-xl text-xs text-text-muted">{row.description || "暂无说明"}</p></div>, sortValue: (row) => row.name },
              { key: "branch", header: "SP 分支", cell: (row) => <span className="font-mono text-xs">{row.sourceBranch}</span> },
              { key: "createdAt", header: "创建时间", cell: (row) => formatDateTime(row.createdAt), sortValue: (row) => row.createdAt },
              { key: "id", header: "ID", cell: (row) => <CopyId value={row.projectId} /> },
              { key: "open", header: "", cell: () => <ArrowUpRight aria-label="查看项目结果" className="size-4 text-text-muted" />, className: "w-10" },
            ]}
          />
        )}
      </Card>
    </Page>
  );
}
