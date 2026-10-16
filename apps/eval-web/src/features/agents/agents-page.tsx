import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bot, Plus } from "lucide-react";
import { agentKeys, listAgentConfigs } from "@/api-sdk/agent-configs-api";
import type { AgentConfig } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
        description="定义执行与评估所用的模型、系统提示词和能力。创建项目时选择对应 Agent。"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => void navigate({ to: "/agents/new" })}>新建 Agent</Button>}
      />
      <Card>
        {configs.isPending ? <LoadingBlock /> : configs.error ? <div className="p-4"><ErrorBlock error={configs.error} onRetry={() => void configs.refetch()} /></div> : (
          <DataTable<AgentConfig>
            rows={configs.data}
            rowKey={(row) => row.id}
            searchText={(row) => `${row.name} ${row.description ?? ""} ${row.setting.presetId ?? ""} ${row.setting.model ?? ""}`}
            searchPlaceholder="搜索名称、说明或模型"
            onRowClick={(row) => void navigate({ to: "/agents/$id", params: { id: row.id } })}
            empty={<EmptyState title="还没有 Agent 配置"
              icon={<Bot />} description="设置模型和系统提示词，按任务添加 Skills、Actions 和参考资料。配置可在不同项目中复用。"
              action={<Button variant="primary" onClick={() => void navigate({ to: "/agents/new" })}>新建 Agent</Button>} />}
            columns={[
              { key: "name", header: "Agent", cell: (row) => <div className="min-w-40 py-1"><span className="font-semibold text-text-strong">{row.name}</span>
                <p className="mt-1 line-clamp-2 max-w-xs text-xs text-text-muted">{row.description || "暂无说明"}</p></div>, sortValue: (row) => row.name },
              { key: "model", header: "模型配置", cell: (row) => <div className="max-w-64 break-words text-[13px]">
                {row.setting.presetId || row.setting.model || "跟随默认配置"}
                <p className="mt-1 text-xs text-text-muted">思考强度 · {row.setting.thinking}</p>
              </div> },
              { key: "prompt", header: "系统提示词", cell: (row) => <span className="line-clamp-2 max-w-xs text-[13px] text-text-secondary">{row.setting.systemPrompt || "未设置"}</span> },
              { key: "capabilities", header: "能力与资料", cell: (row) => {
                const counts = [
                  ["Skills", row.setting.skillIds.length], ["Actions", row.setting.actionIds.length],
                  ["MCP", row.setting.mcpServers.length], ["连接器", row.setting.connectorIds.length],
                  ["扩展", row.setting.extensionIds.length], ["子 Agent", row.setting.subagentNames.length],
                  ["参考资料", row.setting.referenceFileIds?.length ?? 0],
                ] as const;
                return <div className="flex max-w-64 flex-wrap gap-1.5">{counts.some(([, count]) => count > 0)
                  ? counts.filter(([, count]) => count > 0).map(([label, count]) => <Badge key={label}>{label} {count}</Badge>)
                  : <span className="text-xs text-text-muted">未添加额外能力</span>}</div>;
              } },
              { key: "id", header: "ID", cell: (row) => <CopyId value={row.id} /> },
            ]}
          />
        )}
      </Card>
    </Page>
  );
}
