import { resolveEvaluationResultsMcp } from "@eval-platform/eval-contracts";
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

/** Finds the service-account MCP registered for Eval's result submission endpoint. */
export async function getEvaluationResultsMcp(signal?: AbortSignal): Promise<EvaluationResultsMcpResolution> {
  const pageSize = 100;
  const first = await api.get<McpServerCollection>(
    `/api/agent-library/mcp-servers?source=user&page=1&pageSize=${pageSize}`,
    signal ? { signal } : undefined,
  );
  const pages = [first];
  for (let page = 2; page <= Math.ceil(first.total / pageSize); page += 1) {
    pages.push(await api.get<McpServerCollection>(
      `/api/agent-library/mcp-servers?source=user&page=${page}&pageSize=${pageSize}`,
      signal ? { signal } : undefined,
    ));
  }
  const resolution = resolveEvaluationResultsMcp(pages.flatMap((page) => page.data));
  if (resolution.kind === "available") return { kind: "available", server: resolution.server };
  if (resolution.kind === "multiple") return { kind: "unavailable", reason: "找到了多个评估结果 MCP，无法确定要绑定哪一个。" };
  if (resolution.kind === "disabled") return { kind: "unavailable", reason: "评估结果 MCP 已配置，但当前未启用。" };
  if (resolution.kind === "invalid-auth") return { kind: "unavailable", reason: "评估结果 MCP 已配置，但需要 Bearer 鉴权。" };
  return { kind: "unavailable", reason: "尚未配置评估结果 MCP，请先在 Eval SP 服务账号中创建 /mcp/evaluation-results。" };
}
