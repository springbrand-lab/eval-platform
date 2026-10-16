import { useQueries } from "@tanstack/react-query";
import { api } from "@/api-sdk/client";
import { Badge } from "@/components/ui/badge";

/** Metadata SP returns for one MCP Server; connection secrets are never included. */
interface McpServerSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly status: string;
  readonly source: "platform" | "user";
  readonly url?: string | null;
  readonly authType?: string | null;
}

type McpSelection = { readonly serverId: string; readonly kind?: string };

/**
 * The shared Agent editor shows Connector Toolkits only; it keeps other MCP selections in the draft
 * unchanged on save. This read-only list makes those selections visible, e.g. the Evaluator result
 * submission MCP (docs/eval-evaluation-result-submission.md).
 */
export function AgentMcpServers({ selections }: { selections: readonly McpSelection[] }) {
  const ids = selections.filter((selection) => selection.kind === undefined).map((selection) => selection.serverId);
  const servers = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["agent-library", "mcp-servers", id],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.get<McpServerSummary>(`/api/agent-library/mcp-servers/${encodeURIComponent(id)}`, { signal }),
      retry: false,
    })),
  });
  if (ids.length === 0) return null;
  return (
    <section aria-label="MCP Server" className="agent-mcp-section w-full border-t border-border pt-4">
      <h2 className="text-sm font-semibold">MCP Server ({ids.length})</h2>
      <p className="mt-1 text-xs text-text-muted">已连接的服务 · 此处只读，保存配置时原样保留</p>
      <div className="mt-3 grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,360px),1fr))]">
        {ids.map((id, index) => {
          const query = servers[index]!;
          const server = query.data;
          return (
            <div key={id} className="min-w-0 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-text-strong">{server?.name ?? (query.isPending ? "加载中…" : "MCP Server不可用")}</span>
                {server && <Badge tone={server.status === "active" ? "success" : "warning"} dot>{server.status === "active" ? "已启用" : server.status}</Badge>}
                {server && <Badge>{server.source === "user" ? "自定义" : "平台"}</Badge>}
              </div>
              {server?.description && <p className="mt-1 text-text-muted">{server.description}</p>}
              {server?.url && <p className="mt-1 break-all font-mono text-xs text-text-secondary">{server.url}</p>}
              {query.isError && <p className="mt-1 text-danger" role="alert">无法读取该MCP Server（可能已删除）：{id}</p>}
              <p className="mt-1 font-mono text-xs text-text-muted">{id}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
