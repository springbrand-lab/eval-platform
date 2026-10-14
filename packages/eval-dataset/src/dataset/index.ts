export * from "./model.js";
export * from "./serialization.js";
export * from "./store.js";

import type { Data, DataInput, Dataset, DatasetInput, DatasetSnapshot } from "./model.js";
import {
  dataIdSchema,
  dataInputSchema,
  dataSchema,
  datasetIdSchema,
  datasetInputSchema,
  datasetSchema,
  datasetSnapshotSchema,
} from "./model.js";
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

export function createDatasetService(store: DatasetStore): DatasetService {
  async function importDocument(document: import("./model.js").DatasetDocument): Promise<DatasetSnapshot> {
    const snapshot = datasetSnapshotSchema.parse({
      dataset: {
        ...document.dataset,
        datasetId: document.dataset.datasetId ?? crypto.randomUUID(),
      },
      data: document.data.map((record) => ({ ...record, dataId: record.dataId ?? crypto.randomUUID() })),
    });
    await store.importDataset(snapshot);
    return datasetSnapshotSchema.parse(snapshot);
  }
  return {
    async createDataset(input) {
      const fields = datasetInputSchema.parse(input);
      const dataset = datasetSchema.parse({ ...fields, datasetId: crypto.randomUUID() });
      await store.createDataset(dataset);
      return datasetSchema.parse(dataset);
    },
    async updateDataset(datasetId, input) {
      const dataset = datasetSchema.parse({
        ...datasetInputSchema.parse(input),
        datasetId: datasetIdSchema.parse(datasetId),
      });
      await store.updateDataset(dataset);
      return datasetSchema.parse(dataset);
    },
    async getDataset(datasetId) {
      const dataset = await store.getDataset(datasetIdSchema.parse(datasetId));
      return dataset === null ? null : datasetSchema.parse(dataset);
    },
    async listDatasets() {
      return datasetSchema.array().readonly().parse(await store.listDatasets());
    },
    async deleteDataset(datasetId) {
      await store.deleteDataset(datasetIdSchema.parse(datasetId));
    },
    async createData(input) {
      const fields = dataInputSchema.parse(input);
      const data = dataSchema.parse({ ...fields, dataId: crypto.randomUUID() });
      await store.createData(data);
      return dataSchema.parse(data);
    },
    async updateData(dataId, input) {
      const data = dataSchema.parse({
        ...dataInputSchema.parse(input),
        dataId: dataIdSchema.parse(dataId),
      });
      await store.updateData(data);
      return dataSchema.parse(data);
    },
    async getData(dataId) {
      const data = await store.getData(dataIdSchema.parse(dataId));
      return data === null ? null : dataSchema.parse(data);
    },
    async listData(datasetId) {
      const selectedId = datasetId === undefined ? undefined : datasetIdSchema.parse(datasetId);
      return dataSchema.array().readonly().parse(await store.listData(selectedId));
    },
    async deleteData(dataId) {
      await store.deleteData(dataIdSchema.parse(dataId));
    },
    async attachData(datasetId, dataIds) {
      await store.attachData(datasetIdSchema.parse(datasetId), dataIdSchema.array().parse(dataIds));
    },
    async detachData(datasetId, dataIds) {
      await store.detachData(datasetIdSchema.parse(datasetId), dataIdSchema.array().parse(dataIds));
    },
    async importDataset(source, format) {
      return importDocument(parseDatasetDocument(source, format));
    },
    async importPromptDataset(input) {
      return importDocument(parsePromptDatasetUpload(input));
    },
    async exportDataset(datasetId, format) {
      const selectedId = datasetIdSchema.parse(datasetId);
      const snapshot = await store.getDatasetSnapshot(selectedId);
      if (snapshot === null) throw new DatasetEntityNotFoundError("dataset", selectedId);
      return serializeDatasetDocument(datasetSnapshotSchema.parse(snapshot), format);
    },
  };
}
