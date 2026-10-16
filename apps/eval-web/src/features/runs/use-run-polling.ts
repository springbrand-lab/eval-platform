import { useQuery } from "@tanstack/react-query";
import { getCurrentRun, getProjectRun, runKeys } from "@/api-sdk/runs-api";
import { isFinished } from "./run-status";

export const POLL_MS = 5_000;

/** Poll while the page is visible and the Run has not finished; React Query pauses hidden tabs. */
export function useCurrentRun(projectId: string) {
  return useQuery({
    queryKey: runKeys.current(projectId),
    queryFn: ({ signal }) => getCurrentRun(projectId, signal),
    refetchInterval: (query) => (query.state.data?.run ? POLL_MS : false),
  });
}

export function useRun(projectId: string, runId: string | null | undefined) {
  return useQuery({
    queryKey: runKeys.detail(projectId, runId ?? ""),
    queryFn: ({ signal }) => getProjectRun(projectId, runId!, signal),
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data && !isFinished(query.state.data.run.status) ? POLL_MS : false),
  });
}
