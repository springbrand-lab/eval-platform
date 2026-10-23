import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getTrajectoryPage, observationKeys, type ObservedKind, type TrajectoryPage } from "@/api-sdk/observations-api";
import { POLL_MS } from "@/features/runs/use-run-polling";
import { equalJson } from "@eval-platform/eval-contracts";
import { distinctNativeRecords, PI_TRAJECTORY_FORMAT, trajectoryRecordIdentity } from "@eval-platform/eval-runtime/harness";

/** A loaded interval, rather than a moving window of a fixed number of tail pages. */
interface LoadedTrajectory {
  readonly events: TrajectoryPage["events"];
  readonly beforeSeq: number | null;
  readonly hasOlder: boolean;
  readonly newestSeq?: number;
}

export function mergeLoadedTrajectory(current: LoadedTrajectory | undefined, incoming: LoadedTrajectory): LoadedTrajectory {
  const ordered = [...current?.events ?? [], ...incoming.events].sort((left, right) => left.ingestSeq - right.ingestSeq);
  const byCursor = new Map<number, TrajectoryPage["events"][number]>();
  const bySource = new Map<string, TrajectoryPage["events"][number]>();
  for (const item of ordered) {
    const key = trajectoryRecordIdentity(item.event);
    for (const prior of [bySource.get(key), byCursor.get(item.ingestSeq)]) {
      if (!prior) continue;
      const { ingestSeq: _old, ...left } = prior.event;
      const { ingestSeq: _new, ...right } = item.event;
      if (!equalJson(left, right)) throw new Error("同一轨迹来源身份或游标包含矛盾事实");
    }
    if (!bySource.has(key)) bySource.set(key, item);
    byCursor.set(item.ingestSeq, item);
  }
  distinctNativeRecords([...bySource.values()].map((item) => item.event));
  const events = [...bySource.values()];
  // An empty first tail has no loaded interval and cannot establish a permanent history boundary.
  const cursor = !current?.events.length || (current.hasOlder && (!incoming.hasOlder || incoming.beforeSeq! < current.beforeSeq!)) ? incoming : current;
  return { events, beforeSeq: cursor.beforeSeq, hasOlder: cursor.hasOlder,
    newestSeq: Math.max(current?.newestSeq ?? 0, incoming.newestSeq ?? 0, ordered.at(-1)?.ingestSeq ?? 0) };
}

/** One query cache owns the loaded interval; tail refresh and older reads both merge into it. */
export function useTrajectory(input: { projectId: string; kind: ObservedKind; id: string; running: boolean }) {
  const { projectId, kind, id, running } = input;
  const queryClient = useQueryClient();
  const queryKey = observationKeys.part(projectId, kind, id, "trajectory");

  async function read(beforeSeq?: number, signal?: AbortSignal) {
    const page = await getTrajectoryPage(projectId, kind, id, beforeSeq, signal);
    if (page.format !== PI_TRAJECTORY_FORMAT) throw new Error("轨迹格式未知");
    if (page.hasOlder && (page.beforeSeq === null || (beforeSeq !== undefined && page.beforeSeq >= beforeSeq))) {
      throw new Error("轨迹分页游标未前进");
    }
    return page;
  }

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const current = queryClient.getQueryData<LoadedTrajectory>(queryKey);
      const newest = current?.newestSeq || current?.events.at(-1)?.ingestSeq;
      const pages = [await read(undefined, signal)];
      // More than one page may arrive between polls. Read back to the loaded interval, not just the new tail.
      while (newest !== undefined && pages.at(-1)!.hasOlder && pages.at(-1)!.beforeSeq! > newest) {
        pages.push(await read(pages.at(-1)!.beforeSeq!, signal));
      }
      return { ...pages.at(-1)!, events: pages.flatMap((page) => page.events) };
    },
    // Merge at the cache write, so concurrent history reads cannot be overwritten by a refresh.
    structuralSharing: (current, incoming) => mergeLoadedTrajectory(current as LoadedTrajectory | undefined, incoming as LoadedTrajectory),
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
