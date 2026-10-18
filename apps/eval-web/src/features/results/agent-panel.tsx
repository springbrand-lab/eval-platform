import { Link } from "@tanstack/react-router";
import { Eye, ExternalLink } from "lucide-react";
import type { AgentMetricView } from "@/api-sdk/types";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, DescriptionList } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { CopyId } from "@/components/ui/data-display";
import { formatDateTime, formatDuration } from "@/lib/format";
import { langfuseSessionUrl } from "@/lib/langfuse";
import { ResourceMetrics } from "@/features/metrics/resource-metrics";

export function LangfuseLink({ chatId, label = "Langfuse 会话" }: { chatId: string | null | undefined; label?: string }) {
  const url = langfuseSessionUrl(chatId);
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13px] link font-semibold">
      {label}<ExternalLink className="size-3.5" />
    </a>
  );
}

/** One Agent (the Subject or an Evaluator): status, Attempts, resources and evidence. */
export function AgentPanel({ title, agent, observe }: {
  title: string;
  agent: AgentMetricView;
  observe?: { to: string; params: Record<string, string> };
}) {
  const resources = agent.resources;
  return (
    <Card>
      <CardHeader
        title={title}
        actions={(
          <>
            <LangfuseLink chatId={agent.chatId} />
            {observe && agent.chatId && (
              <Link to={observe.to} params={observe.params as never} className="inline-flex items-center gap-1 text-[13px] link font-semibold">
                <Eye className="size-3.5" />查看会话
              </Link>
            )}
          </>
        )}
      />
      <CardBody className="flex flex-col gap-5">
        <div className="grid gap-6 lg:grid-cols-2">
          <DescriptionList items={[
            { label: "状态", value: <StatusBadge status={agent.stage.status} /> },
            ...(agent.stage.lastError ? [{ label: "错误", value: <span className="text-danger">{agent.stage.lastError}</span> }] : []),
            { label: "开始", value: formatDateTime(agent.firstStartedAt) },
            { label: "结束", value: formatDateTime(agent.lastCompletedAt) },
            { label: "耗时", value: formatDuration(agent.agentDurationMs) },
            { label: "Chat", value: agent.chatId ? <CopyId value={agent.chatId} /> : "—" },
          ]} />
        </div>
        {agent.artifacts.length > 0 ? (
          <section aria-label={`${title}产物`}>
            <h3 className="mb-3 text-sm font-semibold text-text-strong">产物证据 · {agent.artifacts.length}</h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {agent.artifacts.map((artifact) => (
                <li key={artifact.artifactId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                  <span className="min-w-0 break-all font-mono text-[13px]">{artifact.path}</span>
                  <span className="text-xs text-text-muted">{artifact.kind}</span>
                </li>
              ))}
            </ul>
            {observe && agent.chatId && <p className="mt-2 text-xs text-text-muted">在「查看会话 → Workspace」中检查文件内容，轨迹用于辅助核对执行过程。</p>}
          </section>
        ) : <p className="text-sm text-text-muted">尚无已收集的产物。</p>}
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">资源与尝试明细</summary>
          <div className="flex flex-col gap-5 border-t border-border p-4">
        <ResourceMetrics statistics={resources} stageStatus={agent.stage.status} />
        {agent.attempts.items.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold text-text-muted">尝试（{agent.attempts.count}，重启 {agent.attempts.restarts} 次）</p>
            <div className="rounded-[var(--radius-control)] border border-border">
              <DataTable
                rows={agent.attempts.items}
                rowKey={(row) => String(row.attemptNumber)}
                columns={[
                  { key: "n", header: "#", cell: (row) => row.attemptNumber },
                  { key: "status", header: "状态", cell: (row) => <StatusBadge status={row.status} /> },
                  { key: "start", header: "开始", cell: (row) => formatDateTime(row.startedAt) },
                  { key: "duration", header: "耗时", cell: (row) => formatDuration(row.durationMs) },
                  { key: "error", header: "错误", cell: (row) => <span className="line-clamp-2 text-danger">{row.error ?? ""}</span> },
                ]}
              />
            </div>
          </div>
        )}
          </div>
        </details>
      </CardBody>
    </Card>
  );
}
