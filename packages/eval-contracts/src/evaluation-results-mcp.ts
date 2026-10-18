/** Public MCP endpoint used by Evaluation Agents to submit structured results. */
export const EVALUATION_RESULTS_MCP_PATH = "/mcp/evaluation-results";

/** Checks the canonical path without trusting a server's display name or description. */
export function isEvaluationResultsMcpUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/u, "") || "/";
    return path === EVALUATION_RESULTS_MCP_PATH;
  } catch {
    return false;
  }
}
