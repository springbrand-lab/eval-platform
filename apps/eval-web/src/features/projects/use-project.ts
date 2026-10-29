import { useQuery, useQueryClient, type QueryClient, type QueryFilters } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getProject, projectKeys } from "@/api-sdk/projects-api";
import { comparisonKeys } from "@/api-sdk/comparison-api";
import { POLL_MS } from "@/features/runs/use-run-polling";

/** Abort earlier snapshots even when they have no cached data, then fetch the current results. */
export async function refreshProjectResults(client: QueryClient, projectId: string): Promise<void> {
  const comparisons: QueryFilters = {
    queryKey: comparisonKeys.all,
    predicate: ({ queryKey }) => Array.isArray(queryKey[1]) && queryKey[1].includes(projectId),
  };
  await Promise.all([...[
    ["metrics", projectId], ["evaluations", projectId], ["observation", projectId], ["runs", "detail", projectId],
  ].map(async (queryKey) => {
    await client.cancelQueries({ queryKey });
    await client.invalidateQueries({ queryKey });
  }), (async () => {
    await client.cancelQueries(comparisons);
    await client.invalidateQueries(comparisons);
  })()]);
}

/** One Project query owns the visible lifecycle, including Runs completed between polls. */
export function useProject(projectId: string) {
  const client = useQueryClient();
  const view = useQuery({ queryKey: projectKeys.detail(projectId), queryFn: ({ signal }) => getProject(projectId, signal), staleTime: 0, refetchInterval: POLL_MS });
  const runId = view.data?.currentRun?.runId ?? null;
  const runSequence = view.data?.runSequence;
  const previous = useRef({ projectId, runId, runSequence });
  useEffect(() => {
    const last = previous.current;
    if (view.data && last.projectId === projectId && ((last.runId !== null && last.runId !== runId)
      || (last.runSequence !== undefined && last.runSequence !== runSequence))) {
      void refreshProjectResults(client, projectId);
    }
    previous.current = { projectId, runId, runSequence };
  }, [projectId, runId, runSequence, view.data, client]);
  return view;
}
