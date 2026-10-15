import type { Data, Dataset, DatasetSnapshot } from "./model.js";

export interface DatasetStore {
  createDataset(dataset: Dataset): Promise<void>;
  updateDataset(dataset: Dataset): Promise<void>;
  getDataset(datasetId: string): Promise<Dataset | null>;
  listDatasets(): Promise<readonly Dataset[]>;
  deleteDataset(datasetId: string): Promise<void>;
  createData(data: Data): Promise<void>;
  updateData(data: Data): Promise<void>;
  getData(dataId: string): Promise<Data | null>;
  listData(datasetId?: string): Promise<readonly Data[]>;
  deleteData(dataId: string): Promise<void>;
  attachData(datasetId: string, dataIds: readonly string[]): Promise<void>;
  detachData(datasetId: string, dataIds: readonly string[]): Promise<void>;
  getDatasetSnapshot(datasetId: string): Promise<DatasetSnapshot | null>;
  /** `prompt` persists the stricter Dataset kind; omitted means general import. */
  importDataset(snapshot: DatasetSnapshot, options?: { readonly kind: "prompt" }): Promise<void>;
}

/** A user-supplied Dataset document, upload or Data input is invalid. */
export class DatasetInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatasetInputError";
  }
}

export class DatasetEntityNotFoundError extends Error {
  constructor(readonly entity: "dataset" | "data", readonly entityId: string) {
    super(`Unknown ${entity}: ${entityId}`);
    this.name = "DatasetEntityNotFoundError";
  }
}

export class DatasetIdentityConflictError extends Error {
  constructor(readonly entity: "dataset" | "data", readonly entityId: string, options?: ErrorOptions) {
    super(`Conflicting ${entity} identity: ${entityId}`, options);
    this.name = "DatasetIdentityConflictError";
  }
}

export class DataInUseError extends Error {
  constructor(readonly dataId: string) {
    super(`Data is still referenced: ${dataId}`);
    this.name = "DataInUseError";
  }
}
