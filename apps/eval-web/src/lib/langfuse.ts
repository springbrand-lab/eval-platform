// Eval SP reports each Chat as one Langfuse session; judge scores sit on the Subject's session.

const PROJECT_URL = (import.meta.env.VITE_LANGFUSE_PROJECT_URL ?? "").replace(/\/+$/u, "");

export function langfuseConfigured(projectUrl = PROJECT_URL): boolean {
  return projectUrl.length > 0;
}

export function langfuseSessionUrl(chatId: string | null | undefined, projectUrl = PROJECT_URL): string | null {
  const base = projectUrl.replace(/\/+$/u, "");
  if (!chatId || !base) return null;
  return `${base}/sessions/${encodeURIComponent(chatId)}`;
}

/** The judge score's fixed Langfuse ID, as written by the Run Worker. */
export function langfuseScoreId(evaluationId: string): string {
  return `eval-score:${evaluationId}`;
}
