import { agentImportTaskViewSchema, type AgentImportApply, type AgentImportPreview, type AgentImportSourceUser, type AgentImportTaskView } from "@eval-platform/eval-contracts";

export const AGENT_IMPORT_PAGE_SIZE = 20;
export const AGENT_IMPORT_POLL_MS = 2_000;

export function agentImportUserName(user: AgentImportSourceUser | null): string {
  return user?.official ? "官方" : user?.name.trim() || "未命名用户";
}

/** UI-owned keys; the transport SDK has no query/cache or workflow state. */
export const agentImportKeys = {
  config: ["agent-imports", "config"] as const,
  users: ["agent-imports", "users"] as const,
  candidatesAll: ["agent-imports", "candidates"] as const,
  candidates: (userId: string, q: string, cursor: string | null) => ["agent-imports", "candidates", userId, q, cursor] as const,
  task: (targetUserId: string, id: string) => ["agent-imports", "task", targetUserId, id] as const,
};

/** A captured UI intent, not another public request or task DTO. */
export interface AgentImportSession {
  id: string;
  targetUserId: string;
  request: Pick<AgentImportPreview, "sourceUserId" | "purpose" | "agentIds">;
  apply?: AgentImportApply;
  started: boolean;
  restored: boolean;
}

export class InvalidAgentImportTaskError extends Error {}

export function parseAgentImportTask(value: unknown, taskId: string): AgentImportTaskView {
  const result = agentImportTaskViewSchema.safeParse(value);
  if (!result.success || result.data.id !== taskId
    || new Set(result.data.agents.map((agent) => agent.id)).size !== result.data.agents.length) {
    throw new InvalidAgentImportTaskError("任务响应与请求不一致或内容无效，不能恢复或确认导入。");
  }
  return result.data;
}

export function isAgentImportTerminal(status: AgentImportTaskView["status"]): boolean {
  return ["completed", "completed_with_errors", "failed", "outcome_unknown"].includes(status);
}

export function matchesAgentImportTask(session: AgentImportSession, task: AgentImportTaskView): boolean {
  const ids = new Set(session.request.agentIds);
  return task.id === session.id && task.sourceUserId === session.request.sourceUserId
    && task.purpose === session.request.purpose && task.agents.length === ids.size
    && new Set(task.agents.map((agent) => agent.id)).size === ids.size
    && task.agents.every((agent) => ids.has(agent.id));
}
