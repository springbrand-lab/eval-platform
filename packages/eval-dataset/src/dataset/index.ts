import type { Data, DataInput, Dataset, DatasetDocument, DatasetInput, DatasetSnapshot } from "./model.js";
import {
  dataInputSchema,
  dataSchema,
  datasetInputSchema,
  datasetSchema,
  datasetSnapshotSchema,
  platformIdSchema,
} from "./model.js";
import { parseInput } from "./input.js";
import type { DatasetFormat, PromptDatasetUploadInput } from "./serialization.js";
import { parseDatasetDocument, parsePromptDatasetUpload, serializeDatasetDocument } from "./serialization.js";
import type { DatasetStore } from "./store.js";
import { DatasetEntityNotFoundError } from "./store.js";

export interface DatasetService {
  createDataset(input: DatasetInput): Promise<Dataset>;
  updateDataset(datasetId: string, input: DatasetInput): Promise<Dataset>;
  getDataset(datasetId: string): Promise<Dataset | null>;
  listDatasets(): Promise<readonly Dataset[]>;
  deleteDataset(datasetId: string): Promise<void>;
  createData(input: DataInput): Promise<Data>;
  updateData(dataId: string, input: DataInput): Promise<Data>;
  getData(dataId: string): Promise<Data | null>;
  listData(datasetId?: string): Promise<readonly Data[]>;
  deleteData(dataId: string): Promise<void>;
  attachData(datasetId: string, dataIds: readonly string[]): Promise<void>;
  detachData(datasetId: string, dataIds: readonly string[]): Promise<void>;
  importDataset(source: string, format: DatasetFormat): Promise<DatasetSnapshot>;
  importPromptDataset(input: PromptDatasetUploadInput): Promise<DatasetSnapshot>;
  exportDataset(datasetId: string, format: DatasetFormat): Promise<string>;
}

const platformId = (value: string): string => parseInput(() => platformIdSchema.parse(value));
const platformIds = (values: readonly string[]): string[] => parseInput(() => platformIdSchema.array().parse(values));

/**
 * Caller input is validated at this boundary and fails as DatasetInputError; Store output is validated
 * again on the way out, and its failures stay internal.
 */
export function createDatasetService(store: DatasetStore): DatasetService {
  async function importDocument(document: DatasetDocument, options?: { readonly kind: "prompt" }): Promise<DatasetSnapshot> {
    const snapshot = datasetSnapshotSchema.parse({
      dataset: {
        ...document.dataset,
        datasetId: document.dataset.datasetId ?? crypto.randomUUID(),
      },
      data: document.data.map((record) => ({ ...record, dataId: record.dataId ?? crypto.randomUUID() })),
    });
    if (options) await store.importDataset(snapshot, options);
    else await store.importDataset(snapshot);
    return datasetSnapshotSchema.parse(snapshot);
  }
  return {
    async createDataset(input) {
      const fields = parseInput(() => datasetInputSchema.parse(input));
      const dataset = datasetSchema.parse({ ...fields, datasetId: crypto.randomUUID() });
      await store.createDataset(dataset);
      return datasetSchema.parse(dataset);
    },
    async updateDataset(datasetId, input) {
      const dataset = parseInput(() => datasetSchema.parse({
        ...datasetInputSchema.parse(input),
        datasetId: platformIdSchema.parse(datasetId),
      }));
      await store.updateDataset(dataset);
      return datasetSchema.parse(dataset);
    },
    async getDataset(datasetId) {
      const dataset = await store.getDataset(platformId(datasetId));
      return dataset === null ? null : datasetSchema.parse(dataset);
    },
    async listDatasets() {
      return datasetSchema.array().readonly().parse(await store.listDatasets());
    },
    async deleteDataset(datasetId) {
      await store.deleteDataset(platformId(datasetId));
    },
    async createData(input) {
      const fields = parseInput(() => dataInputSchema.parse(input));
      const data = dataSchema.parse({ ...fields, dataId: crypto.randomUUID() });
      await store.createData(data);
      return dataSchema.parse(data);
    },
    async updateData(dataId, input) {
      const data = parseInput(() => dataSchema.parse({
        ...dataInputSchema.parse(input),
        dataId: platformIdSchema.parse(dataId),
      }));
      await store.updateData(data);
      return dataSchema.parse(data);
    },
    async getData(dataId) {
      const data = await store.getData(platformId(dataId));
      return data === null ? null : dataSchema.parse(data);
    },
    async listData(datasetId) {
      const selectedId = datasetId === undefined ? undefined : platformId(datasetId);
      return dataSchema.array().readonly().parse(await store.listData(selectedId));
    },
    async deleteData(dataId) {
      await store.deleteData(platformId(dataId));
    },
    async attachData(datasetId, dataIds) {
      await store.attachData(platformId(datasetId), platformIds(dataIds));
    },
    async detachData(datasetId, dataIds) {
      await store.detachData(platformId(datasetId), platformIds(dataIds));
    },
    async importDataset(source, format) {
      return importDocument(parseDatasetDocument(source, format));
    },
    async importPromptDataset(input) {
      return importDocument(parsePromptDatasetUpload(input), { kind: "prompt" });
    },
    async exportDataset(datasetId, format) {
      const selectedId = platformId(datasetId);
      const snapshot = await store.getDatasetSnapshot(selectedId);
      if (snapshot === null) throw new DatasetEntityNotFoundError("dataset", selectedId);
      return serializeDatasetDocument(datasetSnapshotSchema.parse(snapshot), format);
    },
  };
}
