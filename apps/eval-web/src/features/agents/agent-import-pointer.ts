import { agentImportTaskViewSchema } from "@eval-platform/eval-contracts";

/** Origin and verified target identity are part of the namespace, never inferred from a dev user. */
export const agentImportPointerKey = (targetUserId: string) =>
  `eval-web:agent-import:v1:${encodeURIComponent(window.location.origin)}:${encodeURIComponent(targetUserId)}`;

type PointerRead = { taskId: string | null; issue: "invalid" | "unavailable" | null };

function taskIdFromPointer(raw: string): string | null {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1 || !("taskId" in value)) return null;
  const id = agentImportTaskViewSchema.shape.id.safeParse(value.taskId);
  return id.success ? id.data : null;
}

export function readAgentImportPointer(targetUserId: string): PointerRead {
  try {
    const key = agentImportPointerKey(targetUserId);
    const raw = window.localStorage.getItem(key);
    if (raw === null) return { taskId: null, issue: null };
    let taskId: string | null = null;
    try { taskId = taskIdFromPointer(raw); } catch { /* Malformed JSON is not a task. */ }
    if (taskId) return { taskId, issue: null };
    window.localStorage.removeItem(key);
    return { taskId: null, issue: "invalid" };
  } catch {
    return { taskId: null, issue: "unavailable" };
  }
}

export function saveAgentImportPointer(targetUserId: string, taskId: string): boolean {
  try {
    const id = agentImportTaskViewSchema.shape.id.parse(taskId);
    window.localStorage.setItem(agentImportPointerKey(targetUserId), JSON.stringify({ taskId: id }));
    return true;
  } catch {
    return false;
  }
}

/** Do not erase another tab's newer pointer when abandoning an older preview. */
export function clearAgentImportPointer(targetUserId: string, taskId: string): boolean {
  try {
    const key = agentImportPointerKey(targetUserId);
    const raw = window.localStorage.getItem(key);
    if (raw !== null && taskIdFromPointer(raw) === taskId) window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
