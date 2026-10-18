/** The editor's public SP operations. Config writes stay behind Eval's frozen-copy service. */
export const AGENT_LIBRARY_ROUTES = [
  { method: "get", path: "/default-template", upstream: "/api/user-agent-configs/default-template", body: "none" },
  { method: "get", path: "/models", upstream: "/api/model-catalog", body: "none" },
  { method: "get", path: "/skills", upstream: "/api/skills", body: "none" },
  { method: "post", path: "/skills", upstream: "/api/skills", body: "zip" },
  { method: "get", path: "/skills/{id}/files", upstream: "/api/skills/{id}/files", body: "none" },
  { method: "delete", path: "/skills/{id}", upstream: "/api/skills/{id}", body: "none" },
  { method: "get", path: "/actions", upstream: "/api/actions", body: "none" },
  { method: "get", path: "/actions/group-actions", upstream: "/api/actions/group-actions", body: "none" },
  { method: "get", path: "/actions/{id}", upstream: "/api/actions/{id}", body: "none" },
  { method: "get", path: "/components", upstream: "/api/components", body: "none" },
  { method: "get", path: "/connectors", upstream: "/api/connectors", body: "none" },
  { method: "post", path: "/connectors/attempts", upstream: "/api/connectors/attempts", body: "json" },
  { method: "get", path: "/connectors/attempts/{id}", upstream: "/api/connectors/attempts/{id}", body: "none" },
  { method: "get", path: "/user-references", upstream: "/api/user-references", body: "none" },
  { method: "post", path: "/user-references", upstream: "/api/user-references", body: "json" },
  { method: "get", path: "/user-references/{id}", upstream: "/api/user-references/{id}", body: "none" },
  { method: "put", path: "/user-references/{id}/content", upstream: "/api/user-references/{id}/content", body: "json" },
  { method: "patch", path: "/user-references/{id}", upstream: "/api/user-references/{id}", body: "json" },
  { method: "delete", path: "/user-references/{id}", upstream: "/api/user-references/{id}", body: "none" },
  { method: "post", path: "/inbox/attachments", upstream: "/api/inbox/attachments", body: "multipart" },
  { method: "delete", path: "/inbox/attachments", upstream: "/api/inbox/attachments", body: "none" },
  // Read-only: the shared editor has no MCP section, so Eval Web shows selected user MCP Servers itself
  // and resolves the canonical evaluation-result server when the Agent purpose is changed.
  { method: "get", path: "/mcp-servers", upstream: "/api/mcp-servers", body: "none" },
  { method: "get", path: "/mcp-servers/{id}", upstream: "/api/mcp-servers/{id}", body: "none" },
  { method: "get", path: "/user-agent-configs/{id}/deletion-check", upstream: "/api/user-agent-configs/{id}/deletion-check", body: "none" },
] as const;

export type AgentLibraryRoute = typeof AGENT_LIBRARY_ROUTES[number];
export interface AgentLibraryRequest {
  readonly route: AgentLibraryRoute;
  readonly id?: string;
  readonly search: string;
  readonly body?: unknown;
  readonly signal: AbortSignal;
}

export function agentLibraryPath(input: AgentLibraryRequest): string {
  if (!input.route.upstream.includes("{id}")) return input.route.upstream + input.search;
  if (!input.id) throw new TypeError("Agent library resource ID is required");
  return input.route.upstream.replace("{id}", encodeURIComponent(input.id)) + input.search;
}
