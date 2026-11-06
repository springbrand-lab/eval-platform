import { isEvaluationResultsMcpUrl } from "@eval-platform/eval-contracts";
import { selectedMcpServerIds as managedMcpServerIds } from "@springbrand/agent-contracts/agent-config";
import type { EvalSpMcpServer } from "./sp/client.js";

/** Returns all user MCPs at the canonical result path, including unavailable records. */
export function evaluationResultsMcpCandidates(servers: readonly EvalSpMcpServer[]): readonly EvalSpMcpServer[] {
  return servers.filter((server) => server.source === "user" && !!server.url && isEvaluationResultsMcpUrl(server.url));
}
export function selectedMcpServerIds(config: Readonly<Record<string, unknown>>): readonly string[] {
  const setting = config.setting;
  if (!setting || typeof setting !== "object") return [];
  const mcpServers = (setting as { readonly mcpServers?: unknown }).mcpServers;
  if (!Array.isArray(mcpServers)) return [];
  return managedMcpServerIds(mcpServers.filter((selection) => !!selection && typeof selection === "object"))
    .filter((id) => typeof id === "string" && id.length > 0);
}
