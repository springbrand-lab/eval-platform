import { isEvaluationResultsMcpUrl } from "@eval-platform/eval-contracts";
import { api } from "./client";

/** Metadata SP returns for one MCP Server; connection secrets are never included. */
export interface McpServerSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly status: "active" | "disabled" | string;
  readonly source: "platform" | "user";
  readonly url?: string | null;
  readonly authType?: "binding" | "none" | "bearer" | string | null;
}

interface McpServerCollection {
  readonly data: readonly McpServerSummary[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export type EvaluationResultsMcpResolution =
  | { readonly kind: "available"; readonly server: McpServerSummary }
  | { readonly kind: "unavailable"; readonly reason: string };

export const mcpServerKeys = {
  evaluationResults: ["agent-library", "evaluation-results-mcp"] as const,
};

function isEvaluationResultsMcp(server: McpServerSummary): boolean {
  if (server.source !== "user" || !server.url) return false;
  return isEvaluationResultsMcpUrl(server.url);
}

/** Finds the service-account MCP registered for Eval's result submission endpoint. */
export async function getEvaluationResultsMcp(signal?: AbortSignal): Promise<EvaluationResultsMcpResolution> {
  const collection = await api.get<McpServerCollection>(
    "/api/agent-library/mcp-servers?source=user&page=1&pageSize=100",
    signal ? { signal } : undefined,
  );
  const matches = collection.data.filter(isEvaluationResultsMcp);
  const active = matches.filter((server) => server.status === "active" && server.authType === "bearer");
  if (active.length === 1) return { kind: "available", server: active[0]! };
  if (active.length > 1) return { kind: "unavailable", reason: "找到了多个评估结果 MCP，无法确定要绑定哪一个。" };
  if (matches.some((server) => server.status !== "active")) return { kind: "unavailable", reason: "评估结果 MCP 已配置，但当前未启用。" };
  if (matches.length > 0) return { kind: "unavailable", reason: "评估结果 MCP 已配置，但需要 Bearer 鉴权。" };
  return { kind: "unavailable", reason: "尚未配置评估结果 MCP，请先在 Eval SP 服务账号中创建 /mcp/evaluation-results。" };
}
