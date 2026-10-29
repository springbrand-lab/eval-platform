import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { spPiTrajectoryPageSchema, type SpPiTrajectoryPageRow } from "@eval-platform/eval-contracts";
import { getTrajectoryPage, observationKeys, type ObservedKind, type TrajectoryPage } from "@/api-sdk/observations-api";
import { POLL_MS } from "@/features/runs/use-run-polling";

/** A continuous loaded prefix through one frozen cutoff; a refresh only starts after its terminal page. */
interface LoadedTrajectory extends TrajectoryPage {
  readonly requestedAfterSeq: number;
}

function merge(current: LoadedTrajectory | undefined, incoming: LoadedTrajectory): LoadedTrajectory {
  if (!current) return incoming;
  if (incoming === current) return current;
  // A stale page cannot replace a newer cutoff or skip an unfinished page. Refresh
  // starts at the old cutoff only after the entire old range has been drained.
  if (incoming.cursor.throughSeq < current.cursor.throughSeq
    || incoming.cursor.throughSeq === current.cursor.throughSeq
      && incoming.requestedAfterSeq !== current.nextAfterSeq
      && !(current.nextAfterSeq === null && incoming.requestedAfterSeq === current.cursor.throughSeq)
    || incoming.cursor.throughSeq > current.cursor.throughSeq
      && (current.nextAfterSeq !== null || incoming.requestedAfterSeq !== current.cursor.throughSeq)) return current;
  const bySeq = new Map<number, SpPiTrajectoryPageRow>();
  for (const row of current.records) bySeq.set(row.ingestSeq, row);
  for (const row of incoming.records) bySeq.set(row.ingestSeq, row);
  const records = [...bySeq.values()].sort((left, right) => left.ingestSeq - right.ingestSeq);
  return { ...incoming, records };
}

/** One cache owns the prefix. Manual pages and running refreshes never skip a frozen gap. */
export function useTrajectory(input: { projectId: string; kind: ObservedKind; id: string; running: boolean }) {
  const { projectId, kind, id, running } = input;
  const queryClient = useQueryClient();
  const queryKey = observationKeys.part(projectId, kind, id, "trajectory");

  async function read(afterSeq: number, throughSeq?: number, signal?: AbortSignal): Promise<LoadedTrajectory> {
    const page = await getTrajectoryPage(projectId, kind, id, afterSeq, throughSeq, signal);
    if (!spPiTrajectoryPageSchema.safeParse(page).success
      || page.cursor.throughSeq < afterSeq
      || throughSeq !== undefined && page.cursor.throughSeq !== throughSeq) {
      throw new Error("轨迹响应不是 SAFE Pi 原生 records 页");
    }
    if (page.records.some((row) => row.ingestSeq <= afterSeq)
      || page.nextAfterSeq !== null && page.nextAfterSeq <= afterSeq) {
      throw new Error("轨迹分页游标未前进");
    }
    return { ...page, requestedAfterSeq: afterSeq };
  }

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const current = queryClient.getQueryData<LoadedTrajectory>(queryKey);
      if (current && current.nextAfterSeq !== null) {
        return read(current.nextAfterSeq, current.cursor.throughSeq, signal);
      }
      // The completed cutoff is the next forward cursor. A first empty Chat is
      // allowed to grow; it is not a permanently cached "no history" result.
      return read(current?.cursor.throughSeq ?? 0, undefined, signal);
    },
    // Merge at the cache write, so an in-flight page cannot overwrite another completed page.
    structuralSharing: (current, incoming) => merge(current as LoadedTrajectory | undefined, incoming as LoadedTrajectory),
    refetchInterval: running ? POLL_MS : false,
  });

  const more = useMutation({
    mutationFn: async () => {
      const current = queryClient.getQueryData<LoadedTrajectory>(queryKey);
      if (!current || current.nextAfterSeq === null) return;
      const page = await read(current.nextAfterSeq, current.cursor.throughSeq);
      queryClient.setQueryData<LoadedTrajectory>(queryKey, (latest) => merge(latest, page));
    },
  });
  return { query, more };
}
