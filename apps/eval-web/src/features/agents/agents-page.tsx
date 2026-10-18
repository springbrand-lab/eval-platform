import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bot, CheckCircle2, ClipboardCheck, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { agentKeys, listAgentConfigs, listAgentOptions } from "@/api-sdk/agent-configs-api";
import type { AgentConfig, AgentPurpose } from "@/api-sdk/types";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { EmptyState, ErrorBlock, LoadingBlock, Notice } from "@/components/ui/feedback";

type AgentFilter = "all" | AgentPurpose;

const FILTERS: readonly { value: AgentFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "execution", label: "执行 Agent" },
  { value: "evaluation", label: "评估 Agent" },
];

function purposeLabel(purpose: AgentPurpose | null | undefined): string {
  return purpose === "evaluation" ? "评估 Agent" : purpose === "execution" ? "执行 Agent" : "用途未识别";
}

function purposeTone(purpose: AgentPurpose | null | undefined): "accent" | "info" | "neutral" {
  return purpose === "evaluation" ? "accent" : purpose === "execution" ? "info" : "neutral";
}

export function AgentsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<AgentFilter>("all");
  const configs = useQuery({ queryKey: agentKeys.list(), queryFn: ({ signal }) => listAgentConfigs(signal) });
  const purposes = useQuery({ queryKey: agentKeys.options(), queryFn: ({ signal }) => listAgentOptions(undefined, undefined, signal) });
  const purposeByConfigId = useMemo(() => new Map(
    (purposes.data ?? []).flatMap((option) => option.purpose ? [[option.agentConfig.userAgentId, option.purpose] as const] : []),
  ), [purposes.data]);
  const rows = useMemo(() => (configs.data ?? []).filter((config) => filter === "all" || purposeByConfigId.get(config.id) === filter), [configs.data, filter, purposeByConfigId]);
  const counts = useMemo(() => ({
    all: configs.data?.length ?? 0,
    execution: (configs.data ?? []).filter((config) => purposeByConfigId.get(config.id) === "execution").length,
    evaluation: (configs.data ?? []).filter((config) => purposeByConfigId.get(config.id) === "evaluation").length,
  }), [configs.data, purposeByConfigId]);
  return (
    <Page>
      <PageHeader
        title="Agent 管理"
        description="按用途管理执行与评估 Agent。创建项目时只会看到与用途匹配的配置。"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => void navigate({ to: "/agents/new" })}>新建 Agent</Button>}
      />
      <Card>
        {configs.isPending ? <LoadingBlock /> : configs.error ? <div className="p-4"><ErrorBlock error={configs.error} onRetry={() => void configs.refetch()} /></div> : (
          <>
            {purposes.error && <div className="p-4 pb-0"><Notice tone="warning">用途信息暂时不可用，列表仍可查看；恢复后可按用途筛选。<button type="button" className="ml-2 font-semibold underline" onClick={() => void purposes.refetch()}>重试</button></Notice></div>}
            <DataTable<AgentConfig>
              rows={rows}
              rowKey={(row) => row.id}
              searchText={(row) => `${row.name} ${purposeLabel(purposeByConfigId.get(row.id))} ${row.description ?? ""} ${row.setting.presetId ?? ""} ${row.setting.model ?? ""}`}
              searchPlaceholder="搜索名称、说明或模型"
              onRowClick={(row) => void navigate({ to: "/agents/$id", params: { id: row.id } })}
              toolbar={<div role="tablist" aria-label="按 Agent 用途筛选" className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-surface-muted/70 p-0.5">
                {FILTERS.map((item) => {
                  const selected = filter === item.value;
                  return <button key={item.value} type="button" role="tab" aria-selected={selected} onClick={() => setFilter(item.value)}
                    className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${selected ? "bg-surface text-text-strong shadow-sm" : "text-text-muted hover:text-text-strong"}`}>
                    {item.value === "execution" ? <CheckCircle2 className="size-3.5 text-info" aria-hidden /> : item.value === "evaluation" ? <ClipboardCheck className="size-3.5 text-accent" aria-hidden /> : null}
                    {item.label}<span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] tabular-nums text-text-muted">{counts[item.value]}</span>
                  </button>;
                })}
              </div>}
              empty={<EmptyState title={filter === "all" ? "还没有 Agent 配置" : `还没有${purposeLabel(filter)}配置`}
                icon={<Bot />} description="设置模型和系统提示词，按任务添加 Skills、Actions 和参考资料。配置可在不同项目中复用。"
                action={<Button variant="primary" onClick={() => void navigate({ to: "/agents/new" })}>新建 Agent</Button>} />}
              columns={[
                { key: "name", header: "Agent", cell: (row) => <div className="min-w-40 py-1"><span className="font-semibold text-text-strong">{row.name}</span>
                  <p className="mt-1 line-clamp-2 max-w-xs text-xs text-text-muted">{row.description || "暂无说明"}</p></div>, sortValue: (row) => row.name },
                { key: "purpose", header: "用途", cell: (row) => <Badge tone={purposeTone(purposeByConfigId.get(row.id))} dot>{purposeLabel(purposeByConfigId.get(row.id))}</Badge>, sortValue: (row) => purposeLabel(purposeByConfigId.get(row.id)) },
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
          </>
        )}
      </Card>
    </Page>
  );
}
