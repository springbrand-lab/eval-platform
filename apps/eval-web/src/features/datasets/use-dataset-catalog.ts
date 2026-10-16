import { useQueries, useQuery } from "@tanstack/react-query";
import { datasetKeys, listDatasets, listDatasetData } from "@/api-sdk/datasets-api";

/** Memberships use the same cache as detail pages; no copied reference state. */
export function useDatasetCatalog() {
  const datasets = useQuery({ queryKey: datasetKeys.list(), queryFn: ({ signal }) => listDatasets(signal) });
  const members = useQueries({ queries: (datasets.data ?? []).map((dataset) => ({
    queryKey: datasetKeys.members(dataset.datasetId), queryFn: ({ signal }: { signal: AbortSignal }) => listDatasetData(dataset.datasetId, signal),
  })) });
  return { datasets, members, pending: datasets.isPending || members.some((query) => query.isPending),
    error: datasets.error || members.find((query) => query.error)?.error,
    references: (dataId: string) => (datasets.data ?? []).filter((_, index) => members[index]?.data?.some((data) => data.dataId === dataId)),
  };
}
