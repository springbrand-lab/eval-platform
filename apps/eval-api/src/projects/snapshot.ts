import type { ProjectDatasetSnapshot } from "@eval-platform/eval-contracts";
import type { ProjectSample } from "@eval-platform/eval-runtime";
import { createId } from "@springbrand/utils";
import type { SelectedDataset } from "../db/project-store.js";

/**
 * Binds Datasets to ProjectSamples in binding order: a Data shared by several Datasets becomes one
 * ProjectSample whose `datasetIds` follow the Dataset order.
 */
export function bindProjectSamples(input: {
  readonly projectId: string;
  readonly datasets: readonly SelectedDataset[];
  readonly samplingCountOf: (dataId: string) => number;
}): { datasets: ProjectDatasetSnapshot[]; samples: ProjectSample[] } {
  const samples = new Map<string, ProjectSample & { datasetIds: string[] }>();
  const datasets = input.datasets.map(({ dataset, data }): ProjectDatasetSnapshot => ({
    ...dataset,
    projectSampleIds: data.map((record) => {
      let sample = samples.get(record.dataId);
      if (!sample) {
        sample = {
          projectSampleId: createId(), projectId: input.projectId, dataId: record.dataId, datasetIds: [],
          samplingCount: input.samplingCountOf(record.dataId), data: record,
        };
        samples.set(record.dataId, sample);
      }
      sample.datasetIds.push(dataset.datasetId);
      return sample.projectSampleId;
    }),
  }));
  return { datasets, samples: [...samples.values()] };
}
