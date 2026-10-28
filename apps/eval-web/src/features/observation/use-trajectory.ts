import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isSafePiTrajectoryRecord, isSpPiTrajectoryReference, spPiTrajectoryReferenceSchema, type SpPiTrajectoryPageRow } from "@eval-platform/eval-contracts";
import { getTrajectoryPage, observationKeys, type ObservedKind, type TrajectoryPage } from "@/api-sdk/observations-api";
import { POLL_MS } from "@/features/runs/use-run-polling";

/** A loaded interval, rather than a moving window of a fixed number of tail pages. */
interface LoadedTrajectory {
  readonly records: TrajectoryPage["records"];
  readonly beforeSeq: number | null;
  readonly hasOlder: boolean;
}

function merge(current: LoadedTrajectory | undefined, incoming: LoadedTrajectory): LoadedTrajectory {
  // Chat debug pages can arrive newest first; keep rows ascending so the last is the refresh cursor.
  // Keep the raw row objects; never clone the (potentially large) Pi record bodies.
  const bySeq = new Map<number, SpPiTrajectoryPageRow>();
  for (const row of current?.records ?? []) bySeq.set(row.ingestSeq, row);
  for (const row of incoming.records) bySeq.set(row.ingestSeq, row);
  const records = [...bySeq.values()].sort((left, right) => left.ingestSeq - right.ingestSeq);
  // An empty first tail has no loaded interval and cannot establish a permanent history boundary.
  const cursor = !current?.records.length || (current.hasOlder && (!incoming.hasOlder || incoming.beforeSeq! < current.beforeSeq!)) ? incoming : current;
  return { records, beforeSeq: cursor.beforeSeq, hasOlder: cursor.hasOlder };
}

/** One query cache owns the loaded interval; tail refresh and older reads both merge into it. */
export function useTrajectory(input: { projectId: string; kind: ObservedKind; id: string; running: boolean }) {
  const { projectId, kind, id, running } = input;
  const queryClient = useQueryClient();
  const queryKey = observationKeys.part(projectId, kind, id, "trajectory");

  async function read(beforeSeq?: number, signal?: AbortSignal) {
    const page = await getTrajectoryPage(projectId, kind, id, beforeSeq, signal);
    if (!Array.isArray(page.records) || !page.records.every((row) =>
      row !== null && typeof row === "object" && Number.isSafeInteger(row.ingestSeq) && row.ingestSeq > 0
      && (isSpPiTrajectoryReference(row) ? spPiTrajectoryReferenceSchema.safeParse(row).success
        : isSafePiTrajectoryRecord(row.record)))) {
      throw new Error("轨迹响应不是 SAFE Pi 原生 records 页");
    }
    if (page.hasOlder && (page.beforeSeq === null || (beforeSeq !== undefined && page.beforeSeq >= beforeSeq))) {
      throw new Error("轨迹分页游标未前进");
    }
    return page;
  }

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const newest = queryClient.getQueryData<LoadedTrajectory>(queryKey)?.records.at(-1)?.ingestSeq;
      let page = await read(undefined, signal);
      const records: SpPiTrajectoryPageRow[] = [];
      // More than one page may arrive between polls. Read back to the loaded interval, not just the new tail.
      for (;;) {
        for (const row of page.records) records.push(row);
        if (newest === undefined || !page.hasOlder || page.beforeSeq! <= newest) break;
        page = await read(page.beforeSeq!, signal);
      }
      return { records, beforeSeq: page.beforeSeq, hasOlder: page.hasOlder };
    },
    // Merge at the cache write, so concurrent history reads cannot be overwritten by a refresh.
    structuralSharing: (current, incoming) => merge(current as LoadedTrajectory | undefined, incoming as LoadedTrajectory),
    refetchInterval: running ? POLL_MS : false,
  });

  const older = useMutation({
    mutationFn: async () => {
      const current = queryClient.getQueryData<LoadedTrajectory>(queryKey);
      if (!current?.hasOlder || current.beforeSeq === null) return;
      const page = await read(current.beforeSeq);
      queryClient.setQueryData<LoadedTrajectory>(queryKey, page);
    },
  });
  return { query, older };
}
