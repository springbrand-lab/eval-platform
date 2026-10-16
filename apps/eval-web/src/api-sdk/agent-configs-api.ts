import { api, enc } from "./client";
import type { AgentConfig, AgentOption, AgentRole } from "./types";
import type { CreateUserAgentConfigInput, UpdateUserAgentConfigInput } from "@springbrand/agent-config-editor/client";

export const agentKeys = {
  all: ["agent-configs"] as const,
  list: () => ["agent-configs", "list"] as const,
  detail: (id: string) => ["agent-configs", "detail", id] as const,
  options: (role?: AgentRole) => ["agents", role ?? "all"] as const,
};

export type AgentConfigInput = CreateUserAgentConfigInput;

export const listAgentConfigs = (signal?: AbortSignal) => api.get<AgentConfig[]>("/api/agent-configs", { signal });
export const getAgentConfig = (id: string, signal?: AbortSignal) => api.get<AgentConfig>(`/api/agent-configs/${enc(id)}`, { signal });
export const createAgentConfig = (input: AgentConfigInput) => api.post<AgentConfig>("/api/agent-configs", input);
export const updateAgentConfig = (id: string, input: UpdateUserAgentConfigInput) =>
  api.patch<AgentConfig>(`/api/agent-configs/${enc(id)}`, input);
export const deleteAgentConfig = (id: string) => api.delete(`/api/agent-configs/${enc(id)}`);
export const listAgentOptions = (role?: AgentRole, signal?: AbortSignal) =>
  api.get<AgentOption[]>("/api/agents", { params: role ? { role } : {}, signal });
