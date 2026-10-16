import { createAgentEditorClient, type AgentEditorRequest, type UserAgentConfigTemplate } from "@springbrand/agent-config-editor/client";
import { api } from "./client";

/** The shared editor sees public SP paths; Eval supplies only its authenticated, allowlisted gateway. */
const request: AgentEditorRequest = (path, options) => {
  const target = path.startsWith("/api/model-catalog")
    ? path.replace("/api/model-catalog", "/api/agent-library/models")
    : `/api/agent-library${path.slice("/api".length)}`;
  return api.request(target, options);
};

export const agentEditorClient = createAgentEditorClient(request);
export const getAgentTemplate = (signal?: AbortSignal) => api.get<UserAgentConfigTemplate>("/api/agent-library/default-template", { signal });
export const agentLibraryKeys = {
  template: ["agent-library", "default-template"] as const,
  models: ["agent-library", "models"] as const,
};
