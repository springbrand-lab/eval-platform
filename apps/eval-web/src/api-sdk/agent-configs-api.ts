import { api, enc } from "./client";
import type { AgentConfig, AgentOption, AgentPurpose, AgentRole } from "./types";
import type { CreateUserAgentConfigInput, UpdateUserAgentConfigInput } from "@springbrand/agent-config-editor/client";

export const agentKeys = {
  all: ["agents"] as const,
  list: () => ["agents", "configs", "list"] as const,
  detail: (id: string) => ["agents", "configs", "detail", id] as const,
  options: (role?: AgentRole, purpose?: AgentPurpose) => ["agents", "options", role ?? "all", purpose ?? "all"] as const,
};

export type AgentConfigInput = CreateUserAgentConfigInput;

export const listAgentConfigs = (signal?: AbortSignal) => api.get<AgentConfig[]>("/api/agent-configs", { signal });
export const getAgentConfig = (id: string, signal?: AbortSignal) => api.get<AgentConfig>(`/api/agent-configs/${enc(id)}`, { signal });
export const createAgentConfig = (input: AgentConfigInput, purpose: AgentPurpose) =>
  api.post<AgentConfig>("/api/agent-configs", { ...input, purpose });
export type AgentConfigUpdateInput = UpdateUserAgentConfigInput & { readonly purpose?: AgentPurpose };
export const updateAgentConfig = (id: string, input: AgentConfigUpdateInput) =>
  api.patch<AgentConfig>(`/api/agent-configs/${enc(id)}`, input);
export const deleteAgentConfig = (id: string) => api.delete(`/api/agent-configs/${enc(id)}`);
export const listAgentOptions = (role?: AgentRole, purpose?: AgentPurpose, signal?: AbortSignal) =>
  api.get<AgentOption[]>("/api/agents", { params: { ...(role ? { role } : {}), ...(purpose ? { purpose } : {}) }, signal });
