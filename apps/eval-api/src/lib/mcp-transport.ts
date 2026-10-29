/** Stateless JSON-RPC framing shared by the two otherwise independent MCP endpoints. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type McpRpcId = string | number;
export type McpRpcResponse =
  | { jsonrpc: "2.0"; id: McpRpcId | null; result: unknown }
  | { jsonrpc: "2.0"; id: McpRpcId | null; error: { code: number; message: string } };

export const mcpResult = (id: McpRpcId, result: unknown): McpRpcResponse => ({ jsonrpc: "2.0", id, result });
export const mcpError = (id: McpRpcId | null, code: number, message: string): McpRpcResponse => ({
  jsonrpc: "2.0", id, error: { code, message },
});

export function isMcpRequest(message: unknown): message is Record<string, unknown> {
  return typeof message === "object" && message !== null && !Array.isArray(message)
    && (message as Record<string, unknown>).jsonrpc === "2.0";
}

interface McpTransport {
  serverInfo: { name: string; version: string };
  tools: readonly unknown[];
  callTool: (id: McpRpcId, params: Record<string, unknown>) => Promise<McpRpcResponse>;
  methodNotFound: (method: unknown) => string;
}

/** Call only after endpoint-specific authentication, parsing, notification and ID checks. */
export async function dispatchMcp(
  method: unknown, id: McpRpcId, params: Record<string, unknown>, transport: McpTransport,
): Promise<McpRpcResponse> {
  switch (method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
      return mcpResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.find((version) => version === requested) ?? MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: transport.serverInfo,
      });
    }
    case "ping":
      return mcpResult(id, {});
    case "tools/list":
      return mcpResult(id, { tools: transport.tools });
    case "tools/call":
      return transport.callTool(id, params);
    default:
      return mcpError(id, -32601, transport.methodNotFound(method));
  }
}
