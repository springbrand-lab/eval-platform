import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { agentKeys, listAgentConfigs } from "@/api-sdk/agent-configs-api";
import type { AgentConfig } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock } from "@/components/ui/feedback";

export function AgentsPage() {
  const navigate = useNavigate();
  const configs = useQuery({ queryKey: agentKeys.list(), queryFn: ({ signal }) => listAgentConfigs(signal) });
  return (
    <Page>
      <PageHeader
        title="Agent"
        description="Eval SP 中服务账号的 Agent 配置。创建 Project 时会冻结所选配置的副本，副本不在这里列出。"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => void navigate({ to: "/agents/new" })}>新建 Agent</Button>}
      />
      <Card>
        {configs.isPending ? <LoadingBlock /> : configs.error ? <div className="p-4"><ErrorBlock error={configs.error} onRetry={() => void configs.refetch()} /></div> : (
          <DataTable<AgentConfig>
            rows={configs.data}
            rowKey={(row) => row.id}
            searchText={(row) => `${row.name} ${row.slug ?? ""} ${row.description ?? ""}`}
            searchPlaceholder="搜索名称或 slug"
            onRowClick={(row) => void navigate({ to: "/agents/$id", params: { id: row.id } })}
            empty={<EmptyState title="还没有 Agent 配置" description="被测 Agent 和评委都需要一个 Agent 配置。"
              action={<Button variant="primary" onClick={() => void navigate({ to: "/agents/new" })}>新建 Agent</Button>} />}
            columns={[
              { key: "name", header: "名称", cell: (row) => <span className="font-semibold">{row.name}</span>, sortValue: (row) => row.name },
              { key: "slug", header: "Slug", cell: (row) => <span className="font-mono text-xs">{row.slug ?? "—"}</span> },
              { key: "description", header: "说明", cell: (row) => <span className="line-clamp-1 text-text-muted">{row.description || "—"}</span> },
              { key: "id", header: "ID", cell: (row) => <CopyId value={row.id} /> },
            ]}
          />
        )}
      </Card>
    </Page>
  );
}
