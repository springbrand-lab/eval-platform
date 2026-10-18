import { isEvaluationResultsMcpUrl } from "@eval-platform/eval-contracts";
import type { AgentPurpose } from "@eval-platform/eval-contracts";
import type { EvalSpAgentConfig, EvalSpMcpServer } from "./sp/client.js";

/** Returns the SP MCP records that represent Eval's result-submission capability. */
export function evaluationResultsMcpServers(servers: readonly EvalSpMcpServer[]): readonly EvalSpMcpServer[] {
  return servers.filter((server) => server.source === "user" && !!server.url && isEvaluationResultsMcpUrl(server.url));
}

export function selectedMcpServerIds(config: Readonly<Record<string, unknown>>): readonly string[] {
  const setting = config.setting;
  if (!setting || typeof setting !== "object") return [];
  const mcpServers = (setting as { readonly mcpServers?: unknown }).mcpServers;
  if (!Array.isArray(mcpServers)) return [];
  return mcpServers.flatMap((selection) => {
    if (!selection || typeof selection !== "object") return [];
    const id = (selection as { readonly serverId?: unknown }).serverId;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  });
}

/** The Agent purpose is derived from the selected canonical MCP at creation/bootstrap time. */
export function purposeOfAgent(config: EvalSpAgentConfig, evaluationServerIds: ReadonlySet<string>): AgentPurpose {
  return evaluationMcpServerId(config, evaluationServerIds) === null ? "execution" : "evaluation";
}

/** Returns the selected canonical result MCP ID, if this config is an Evaluation Agent. */
export function evaluationMcpServerId(config: Readonly<Record<string, unknown>>, evaluationServerIds: ReadonlySet<string>): string | null {
  return selectedMcpServerIds(config).find((id) => evaluationServerIds.has(id)) ?? null;
}
