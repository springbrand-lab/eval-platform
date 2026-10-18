/** Public MCP endpoint used by Evaluation Agents to submit structured results. */
export const EVALUATION_RESULTS_MCP_PATH = "/mcp/evaluation-results";

export interface EvaluationResultsMcpServer {
  readonly id: string;
  readonly source: string;
  readonly status: string;
  readonly url?: string | null;
  readonly authType?: string | null;
}

export type EvaluationResultsMcpResolution<T extends EvaluationResultsMcpServer = EvaluationResultsMcpServer> =
  | { readonly kind: "available"; readonly server: T }
  | { readonly kind: "multiple"; readonly servers: readonly T[] }
  | { readonly kind: "disabled"; readonly servers: readonly T[] }
  | { readonly kind: "invalid-auth"; readonly servers: readonly T[] }
  | { readonly kind: "missing" };

/** Checks the canonical path without trusting a server's display name or description. */
export function isEvaluationResultsMcpUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/u, "") || "/";
    return path === EVALUATION_RESULTS_MCP_PATH;
  } catch {
    return false;
  }
}

/** Resolves the one enabled, Bearer-authenticated result MCP used by Evaluation Agents. */
export function resolveEvaluationResultsMcp<T extends EvaluationResultsMcpServer>(servers: readonly T[]): EvaluationResultsMcpResolution<T> {
  const matches = servers.filter((server) => server.source === "user" && !!server.url && isEvaluationResultsMcpUrl(server.url));
  const active = matches.filter((server) => server.status === "active" && server.authType === "bearer");
  if (active.length === 1) return { kind: "available", server: active[0]! };
  if (active.length > 1) return { kind: "multiple", servers: active };
  if (matches.some((server) => server.status !== "active")) return { kind: "disabled", servers: matches };
  if (matches.length > 0) return { kind: "invalid-auth", servers: matches };
  return { kind: "missing" };
}
