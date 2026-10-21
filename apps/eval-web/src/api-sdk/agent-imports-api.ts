import type {
  AgentImportApply,
  AgentImportCandidatePage,
  AgentImportConfig,
  AgentImportPreview,
  AgentImportSourceUser,
  AgentImportTaskView,
} from "@eval-platform/eval-contracts";
import { api, enc } from "./client";

const base = "/api/agent-config-sync";

export const getAgentImportConfig = (signal?: AbortSignal) =>
  api.get<AgentImportConfig>(`${base}/config`, { signal });
export const listAgentImportUsers = (q: string, limit: number, signal?: AbortSignal) =>
  api.get<{ users: AgentImportSourceUser[] }>(`${base}/users`, { params: { q, limit }, signal });
export const listAgentImportCandidates = (
  sourceUserId: string, input: { q: string; cursor?: string; limit: number }, signal?: AbortSignal,
) => api.get<AgentImportCandidatePage>(`${base}/users/${enc(sourceUserId)}/agents`, {
  params: { ...input, onlyMissing: true }, signal,
});
export const previewAgentImport = (input: AgentImportPreview) =>
  api.post<{ taskId: string }>(`${base}/previews`, input);
export const getAgentImportTask = (taskId: string, signal?: AbortSignal) =>
  api.get<AgentImportTaskView>(`${base}/tasks/${enc(taskId)}`, { signal });
export const applyAgentImport = (taskId: string, input: AgentImportApply) =>
  api.post<{ taskId: string }>(`${base}/tasks/${enc(taskId)}/apply`, input);
