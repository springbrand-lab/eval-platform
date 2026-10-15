import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createDatasetService } from "./index.js";
import type { Data, DataInput, Dataset, DatasetSnapshot } from "./model.js";
import { parseDatasetDocument, serializeDatasetDocument } from "./serialization.js";
import type { DatasetStore } from "./store.js";
import { DataInUseError, DatasetEntityNotFoundError, DatasetIdentityConflictError, DatasetInputError } from "./store.js";

function persisted<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

class TestDatasetStore implements DatasetStore {
  readonly datasets = new Map<string, Dataset>();
  readonly data = new Map<string, Data>();
  readonly memberships = new Map<string, Set<string>>();

  async createDataset(dataset: Dataset): Promise<void> {
    if (this.datasets.has(dataset.datasetId)) {
      throw new DatasetIdentityConflictError("dataset", dataset.datasetId);
    }
    this.datasets.set(dataset.datasetId, persisted(dataset));
    this.memberships.set(dataset.datasetId, new Set());
  }

  async updateDataset(dataset: Dataset): Promise<void> {
    this.requireDataset(dataset.datasetId);
    this.datasets.set(dataset.datasetId, persisted(dataset));
  }

  async getDataset(datasetId: string): Promise<Dataset | null> {
    return this.datasets.get(datasetId) ?? null;
  }

  async listDatasets(): Promise<readonly Dataset[]> {
    return [...this.datasets.values()].sort((left, right) => left.datasetId.localeCompare(right.datasetId));
  }

  async deleteDataset(datasetId: string): Promise<void> {
    this.datasets.delete(datasetId);
    this.memberships.delete(datasetId);
  }

  async createData(data: Data): Promise<void> {
    if (this.data.has(data.dataId)) throw new DatasetIdentityConflictError("data", data.dataId);
    this.data.set(data.dataId, persisted(data));
  }

  async updateData(data: Data): Promise<void> {
    if (!this.data.has(data.dataId)) throw new DatasetEntityNotFoundError("data", data.dataId);
    this.data.set(data.dataId, persisted(data));
  }

  async getData(dataId: string): Promise<Data | null> {
    return this.data.get(dataId) ?? null;
  }

  async listData(datasetId?: string): Promise<readonly Data[]> {
    if (datasetId === undefined) {
      return [...this.data.values()].sort((left, right) => left.dataId.localeCompare(right.dataId));
    }
    this.requireDataset(datasetId);
    return [...this.memberships.get(datasetId)!].sort().map((dataId) => this.data.get(dataId)!);
  }

  async deleteData(dataId: string): Promise<void> {
    if ([...this.memberships.values()].some((ids) => ids.has(dataId))) throw new DataInUseError(dataId);
    this.data.delete(dataId);
  }

  async attachData(datasetId: string, dataIds: readonly string[]): Promise<void> {
    this.requireDataset(datasetId);
    for (const dataId of dataIds) {
      if (!this.data.has(dataId)) throw new DatasetEntityNotFoundError("data", dataId);
    }
    const members = this.memberships.get(datasetId)!;
    for (const dataId of dataIds) members.add(dataId);
  }

  async detachData(datasetId: string, dataIds: readonly string[]): Promise<void> {
    this.requireDataset(datasetId);
    const members = this.memberships.get(datasetId)!;
    for (const dataId of dataIds) members.delete(dataId);
  }

  async getDatasetSnapshot(datasetId: string): Promise<DatasetSnapshot | null> {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) return null;
    return {
      dataset,
      data: [...this.memberships.get(datasetId)!].sort().map((dataId) => this.data.get(dataId)!),
    };
  }

  async importDataset(snapshot: DatasetSnapshot): Promise<void> {
    const incoming = persisted(snapshot);
    for (const entry of incoming.data) {
      const existing = this.data.get(entry.dataId);
      if (existing && !isDeepStrictEqual(existing, entry)) {
        throw new DatasetIdentityConflictError("data", entry.dataId);
      }
    }
    const existing = this.datasets.get(incoming.dataset.datasetId);
    if (existing) {
      const existingIds = [...this.memberships.get(existing.datasetId)!].sort();
      const incomingIds = incoming.data.map((entry) => entry.dataId).sort();
      if (!isDeepStrictEqual(existing, incoming.dataset) || !isDeepStrictEqual(existingIds, incomingIds)) {
        throw new DatasetIdentityConflictError("dataset", existing.datasetId);
      }
      return;
    }
    this.datasets.set(incoming.dataset.datasetId, incoming.dataset);
    this.memberships.set(incoming.dataset.datasetId, new Set(incoming.data.map((entry) => entry.dataId)));
    for (const entry of incoming.data) {
      if (!this.data.has(entry.dataId)) this.data.set(entry.dataId, entry);
    }
  }

  private requireDataset(datasetId: string): void {
    if (!this.datasets.has(datasetId)) throw new DatasetEntityNotFoundError("dataset", datasetId);
  }
}

const initialSession = { bundleId: "1c82ed86-888c-4720-8424-6f38825f6e0c", sessionId: "a8ffecab-9deb-42a4-8c67-990bdb3fd40c" };
const initialMaterials = [
  { bundleId: "69258daa-9897-4756-8ba4-66066a95a19b", materialId: "af593744-2f6b-4d37-84ee-83c29c8ca4fb" },
  { bundleId: "5d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a", materialId: "af593744-2f6b-4d37-84ee-83c29c8ca4fb" },
];

describe("Dataset service", () => {
  it("generates only Dataset/Data entity IDs and preserves both external resource identities", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const generateId = vi.spyOn(crypto, "randomUUID");
    try {
      const dataset = await service.createDataset({ name: "tasks" });
      const data = await service.createData({ userPrompt: "continue", json: { task: "continue" }, initialSession, initialMaterials });
      expect(generateId).toHaveBeenCalledTimes(2);
      expect(dataset.datasetId).not.toBe(data.dataId);
      expect(data).toMatchObject({ initialSession, initialMaterials });
      expect(store.data.get(data.dataId)).toEqual(data);
    } finally {
      generateId.mockRestore();
    }
  });

  it("canonicalizes UUID resource references and rejects any other resource identity", async () => {
    const service = createDatasetService(new TestDatasetStore());
    const bundleId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const materialId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
    const sessionId = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";
    const created = await service.createData({
      userPrompt: "task", externalCode: "ABC",
      initialMaterials: [{ bundleId, materialId }],
      evalInitialMaterials: [{ bundleId, materialId }],
      initialSession: { bundleId, sessionId },
    });
    expect(created).toMatchObject({
      externalCode: "ABC",
      initialMaterials: [{ bundleId: bundleId.toLowerCase(), materialId: materialId.toLowerCase() }],
      evalInitialMaterials: [{ bundleId: bundleId.toLowerCase(), materialId: materialId.toLowerCase() }],
      initialSession: { bundleId: bundleId.toLowerCase(), sessionId: sessionId.toLowerCase() },
    });
    await expect(service.createData({ userPrompt: "task", initialSession: { bundleId: "Session-Bundle/1", sessionId } }))
      .rejects.toBeInstanceOf(DatasetInputError);
  });

  it("fully replaces editable fields without changing entity identity", async () => {
    const service = createDatasetService(new TestDatasetStore());
    const dataset = await service.createDataset({ name: "tasks", description: "old" });
    const data = await service.createData({ userPrompt: "old", json: "old", initialSession, initialMaterials, metadata: { old: true } });
    await expect(service.updateDataset(dataset.datasetId, { name: "updated" }))
      .resolves.toEqual({ datasetId: dataset.datasetId, name: "updated" });
    await expect(service.updateData(data.dataId, { userPrompt: "new" }))
      .resolves.toEqual({ dataId: data.dataId, userPrompt: "new" });
    await expect(service.getData(data.dataId)).resolves.toEqual({ dataId: data.dataId, userPrompt: "new" });
  });

  it("saves and updates each Data's evaluation prompt independently of the Subject prompt", async () => {
    const service = createDatasetService(new TestDatasetStore());
    const created = await service.createData({ userPrompt: "build a page", evalPrompt: "check accessibility" });
    expect(await service.getData(created.dataId)).toEqual(created);
    const updated = await service.updateData(created.dataId, {
      userPrompt: "build a page", evalPrompt: "  check visual alignment  ",
    });
    expect(updated.evalPrompt).toBe("  check visual alignment  ");
    expect(updated.userPrompt).toBe("build a page");
    expect(await service.getData(created.dataId)).toEqual(updated);
  });

  it("preserves a business sampleId through creation, update and persistence", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const created = await service.createData({ userPrompt: "task", sampleId: "source-sample-42" });
    expect(created.sampleId).toBe("source-sample-42");
    expect(store.data.get(created.dataId)).toEqual(created);
    const updated = await service.updateData(created.dataId, { userPrompt: "updated", sampleId: { source: 43 } });
    await expect(service.getData(created.dataId)).resolves.toEqual(updated);
    expect(updated.sampleId).toEqual({ source: 43 });
  });

  it("rejects unsafe integer creation and updates before writing to Store", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const existing = await service.createData({ userPrompt: "original", externalDataId: "9007199254740993" });
    const createData = vi.spyOn(store, "createData");
    const updateData = vi.spyOn(store, "updateData");
    const invalid = { userPrompt: "task", expectedOutput: { ids: [Number.MAX_SAFE_INTEGER + 1] } };
    await expect(service.createData(invalid)).rejects.toBeInstanceOf(DatasetInputError);
    await expect(service.updateData(existing.dataId, invalid)).rejects.toBeInstanceOf(DatasetInputError);
    expect(createData).not.toHaveBeenCalled();
    expect(updateData).not.toHaveBeenCalled();
    expect(store.data.size).toBe(1);
    await expect(service.getData(existing.dataId)).resolves.toEqual(existing);
  });

  it("shares one Data across datasets and reflects its global updates", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const first = await service.createDataset({ name: "first" });
    const second = await service.createDataset({ name: "second" });
    const data = await service.createData({ userPrompt: "original", initialSession, initialMaterials });
    await service.attachData(first.datasetId, [data.dataId, data.dataId]);
    await service.attachData(first.datasetId, [data.dataId]);
    await service.attachData(second.datasetId, [data.dataId]);
    const updated = await service.updateData(data.dataId, { userPrompt: "updated", initialSession, initialMaterials });
    await expect(service.listData(first.datasetId)).resolves.toEqual([updated]);
    await expect(service.listData(second.datasetId)).resolves.toEqual([updated]);
    expect(store.data.size).toBe(1);
  });

  it("rejects a batch with missing Data without attaching a subset", async () => {
    const service = createDatasetService(new TestDatasetStore());
    const dataset = await service.createDataset({ name: "tasks" });
    const data = await service.createData({ userPrompt: "task" });
    await expect(service.attachData(dataset.datasetId, [data.dataId, crypto.randomUUID()]))
      .rejects.toBeInstanceOf(DatasetEntityNotFoundError);
    await expect(service.listData(dataset.datasetId)).resolves.toEqual([]);
  });

  it("preserves shared Data when deleting a Dataset and rejects deleting referenced Data", async () => {
    const service = createDatasetService(new TestDatasetStore());
    const first = await service.createDataset({ name: "first" });
    const second = await service.createDataset({ name: "second" });
    const data = await service.createData({ userPrompt: "task" });
    await service.attachData(first.datasetId, [data.dataId]);
    await service.attachData(second.datasetId, [data.dataId]);
    await service.deleteDataset(first.datasetId);
    await service.deleteDataset(first.datasetId);
    await expect(service.getData(data.dataId)).resolves.toEqual(data);
    await expect(service.deleteData(data.dataId)).rejects.toBeInstanceOf(DataInUseError);
    await service.detachData(second.datasetId, [data.dataId]);
    await service.detachData(second.datasetId, [data.dataId]);
    await service.deleteData(data.dataId);
    await service.deleteData(data.dataId);
    await expect(service.getData(data.dataId)).resolves.toBeNull();
  });

  it("returns null for missing single entities but fails missing Dataset mutations and lists", async () => {
    const service = createDatasetService(new TestDatasetStore());
    const missingId = crypto.randomUUID();
    await expect(service.getDataset(missingId)).resolves.toBeNull();
    await expect(service.getData(missingId)).resolves.toBeNull();
    await expect(service.updateDataset(missingId, { name: "tasks" })).rejects.toBeInstanceOf(DatasetEntityNotFoundError);
    await expect(service.updateData(missingId, { userPrompt: "task" })).rejects.toBeInstanceOf(DatasetEntityNotFoundError);
    await expect(service.listData(missingId)).rejects.toBeInstanceOf(DatasetEntityNotFoundError);
    await expect(service.attachData(missingId, [])).rejects.toBeInstanceOf(DatasetEntityNotFoundError);
    await expect(service.detachData(missingId, [])).rejects.toBeInstanceOf(DatasetEntityNotFoundError);
    await expect(service.exportDataset(missingId, "json")).rejects.toBeInstanceOf(DatasetEntityNotFoundError);
  });

  it("returns stable ID ordering and detached JSON values", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const first = await service.createDataset({ name: "first" });
    const second = await service.createDataset({ name: "second" });
    const input = { userPrompt: "task", json: { task: "original" } };
    const data = await service.createData(input);
    const other = await service.createData({ userPrompt: "other" });
    input.json.task = "mutated input";
    (data.json as { task: string }).task = "mutated result";
    const queried = await service.getData(data.dataId);
    expect(queried?.json).toEqual({ task: "original" });
    (queried!.json as { task: string }).task = "mutated query";
    await expect(service.getData(data.dataId)).resolves.toMatchObject({ json: { task: "original" } });
    expect((await service.listDatasets()).map((dataset) => dataset.datasetId))
      .toEqual([first.datasetId, second.datasetId].sort());
    expect((await service.listData()).map((entry) => entry.dataId))
      .toEqual([data.dataId, other.dataId].sort());
  });

  it("rejects missing resource IDs before persistence without inventing a default", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const createData = vi.spyOn(store, "createData");
    await expect(service.createData({ userPrompt: "task", initialSession: { sessionId: "a8ffecab-9deb-42a4-8c67-990bdb3fd40c" } } as DataInput))
      .rejects.toBeInstanceOf(DatasetInputError);
    await expect(service.createData({ userPrompt: "task", initialMaterials: [{ bundleId: "debddf36-3eeb-41c6-819b-b1f75e365dc2" }] } as unknown as DataInput))
      .rejects.toBeInstanceOf(DatasetInputError);
    expect(createData).not.toHaveBeenCalled();
    expect(store.data.size).toBe(0);
  });

  it("rejects a generated entity ID collision without overwriting the existing record", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const identity = crypto.randomUUID();
    const generateId = vi.spyOn(crypto, "randomUUID").mockReturnValue(identity);
    try {
      await service.createData({ userPrompt: "first" });
      await expect(service.createData({ userPrompt: "second" })).rejects.toBeInstanceOf(DatasetIdentityConflictError);
      await expect(service.getData(identity)).resolves.toEqual({ dataId: identity, userPrompt: "first" });
    } finally {
      generateId.mockRestore();
    }
  });

  it("propagates storage outages and invalid stored output instead of returning an empty success", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const unavailable = new Error("database unavailable");
    vi.spyOn(store, "listDatasets").mockRejectedValue(unavailable);
    await expect(service.listDatasets()).rejects.toBe(unavailable);
    vi.spyOn(store, "getData").mockResolvedValue({ dataId: crypto.randomUUID(), userPrompt: "task", json: Infinity });
    const invalidStored = service.getData(crypto.randomUUID());
    await expect(invalidStored).rejects.toThrow();
    await expect(invalidStored).rejects.not.toBeInstanceOf(DatasetInputError);
  });
});

describe("Dataset input boundary", () => {
  it("reports malformed caller input as DatasetInputError and keeps the parser failure as its cause", async () => {
    const service = createDatasetService(new TestDatasetStore());
    for (const attempt of [
      service.getDataset("not-a-uuid"),
      service.attachData(crypto.randomUUID(), ["not-a-uuid"]),
      service.createDataset({ name: " " }),
      service.importDataset("{", "json"),
      service.importDataset("dataset: [", "yaml"),
      service.importDataset("{}", "toml" as "json"),
      service.importPromptDataset({ name: "Prompts", description: "Rows", format: "jsonl", content: "[]" }),
    ]) {
      const error = await attempt.then(() => undefined, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(DatasetInputError);
      expect((error as Error).cause).toBeDefined();
    }
  });
});

describe("Dataset import and export", () => {
  it("imports a prompt file with separate Dataset metadata in one Store command", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const importStore = vi.spyOn(store, "importDataset");
    const result = await service.importPromptDataset({
      name: "Prompts", description: "Required metadata", format: "jsonl",
      content: '{"name":"First","description":"Task one","userPrompt":"build","evalPrompt":"review"}\n',
    });
    expect(result.dataset).toMatchObject({ name: "Prompts", description: "Required metadata" });
    expect(result.data[0]).toMatchObject({ name: "First", description: "Task one",
      userPrompt: "build", evalPrompt: "review" });
    expect(result.dataset.datasetId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.data[0]!.dataId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(importStore).toHaveBeenCalledExactlyOnceWith(result, { kind: "prompt" });
    await expect(service.importPromptDataset({ name: "Prompts", description: "Required metadata",
      format: "jsonl", content: '{"name":"First","description":"Task one","userPrompt":"build"}\n',
    })).rejects.toBeInstanceOf(DatasetInputError);
    expect(importStore).toHaveBeenCalledTimes(1);
  });
  it.each([
    { format: "json", source: '{"dataset":{"name":"tasks"},"data":[{"userPrompt":"task","externalDataId":9007199254740993}]}' },
    { format: "yaml", source: 'dataset: { name: tasks }\ndata: [{ userPrompt: task, externalDataId: 9007199254740993 }]' },
    { format: "json", source: '{"dataset":{"name":"tasks"},"data":[{"userPrompt":"first","userPrompt":"second"}]}' },
    { format: "json", source: '{"dataset":{"name":"tasks"},"data":[{"userPrompt":"first","user\\u0050rompt":"second"}]}' },
    { format: "yaml", source: 'dataset: { name: tasks }\ndata: [{ userPrompt: first, userPrompt: second }]' },
  ] as const)("rejects invalid $format imports before generating IDs or committing Store", async ({ format, source }) => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const importDataset = vi.spyOn(store, "importDataset");
    const generateId = vi.spyOn(crypto, "randomUUID");
    try {
      await expect(service.importDataset(source, format)).rejects.toBeInstanceOf(DatasetInputError);
      expect(importDataset).not.toHaveBeenCalled();
      expect(generateId).not.toHaveBeenCalled();
      expect(store.datasets.size).toBe(0);
      expect(store.data.size).toBe(0);
      expect(store.memberships.size).toBe(0);
    } finally {
      generateId.mockRestore();
    }
  });

  it.each(["json", "yaml"] as const)("preserves string large IDs and business sampleId across %s import/export", async (format) => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const input = {
      dataset: { name: "tasks" },
      data: [{
        userPrompt: "task",
        sampleId: "source-sample-42",
        externalDataId: "9007199254740993",
        expectedOutput: { ids: ["9007199254740992", "9007199254740993"] },
      }],
    };
    const imported = await service.importDataset(serializeDatasetDocument(input, format), format);
    expect(imported.data[0]).toMatchObject(input.data[0]!);
    expect(store.data.get(imported.data[0]!.dataId)).toEqual(imported.data[0]);
    const exported = await service.exportDataset(imported.dataset.datasetId, format);
    await expect(service.importDataset(exported, format)).resolves.toEqual(imported);
  });

  it.each(["json", "yaml"] as const)("imports %s in one Store command, generating only missing entity IDs", async (format) => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const importDataset = vi.spyOn(store, "importDataset");
    const createDataset = vi.spyOn(store, "createDataset");
    const createData = vi.spyOn(store, "createData");
    const generateId = vi.spyOn(crypto, "randomUUID");
    try {
      const document = {
        dataset: { name: "tasks" },
        data: [{ userPrompt: "continue", requirements: ["responsive"], expectedOutput: { pages: 3 }, initialSession, initialMaterials }],
      };
      const result = await service.importDataset(serializeDatasetDocument(document, format), format);
      expect(generateId).toHaveBeenCalledTimes(2);
      expect(importDataset).toHaveBeenCalledExactlyOnceWith(result);
      expect(createDataset).not.toHaveBeenCalled();
      expect(createData).not.toHaveBeenCalled();
      expect(result.data[0]).toMatchObject({ initialSession, initialMaterials });
      generateId.mockClear();
      const exported = await service.exportDataset(result.dataset.datasetId, format);
      await expect(service.importDataset(exported, format)).resolves.toEqual(result);
      expect(generateId).not.toHaveBeenCalled();
      expect(store.datasets.size).toBe(1);
      expect(store.data.size).toBe(1);
    } finally {
      generateId.mockRestore();
    }
  });

  it("reuses existing Data without copying it or treating JSON property order as a conflict", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const data = await service.createData({ userPrompt: "task", json: { first: 1, second: 2 }, initialSession, initialMaterials });
    const first = await service.importDataset(JSON.stringify({
      dataset: { name: "first" },
      data: [{ ...data, json: { second: 2, first: 1 } }],
    }), "json");
    const second = await service.importDataset(JSON.stringify({ dataset: { name: "second" }, data: [data] }), "json");
    expect(store.data.size).toBe(1);
    await expect(service.listData(first.dataset.datasetId)).resolves.toEqual([data]);
    await expect(service.listData(second.dataset.datasetId)).resolves.toEqual([data]);
  });

  it("rejects a conflicting Data import without leaving a new Dataset or a partial batch", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const existing = await service.createData({ userPrompt: "original", initialSession, initialMaterials });
    const document = {
      dataset: { name: "tasks" },
      data: [{ userPrompt: "new" }, { ...existing, initialSession: { ...initialSession, sessionId: "517d5a72-4086-4ec2-87fa-07542a7bf747" } }],
    };
    await expect(service.importDataset(JSON.stringify(document), "json"))
      .rejects.toBeInstanceOf(DatasetIdentityConflictError);
    expect(store.datasets.size).toBe(0);
    expect(store.memberships.size).toBe(0);
    expect(store.data.size).toBe(1);
    await expect(service.getData(existing.dataId)).resolves.toEqual(existing);
  });

  it("rejects conflicting Dataset content but accepts reordered identical members", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const imported = await service.importDataset(JSON.stringify({ dataset: { name: "tasks" }, data: [{ userPrompt: "first" }, { userPrompt: "second" }] }), "json");
    const reordered = { dataset: imported.dataset, data: [...imported.data].reverse() };
    await expect(service.importDataset(JSON.stringify(reordered), "json")).resolves.toEqual(reordered);
    await expect(service.importDataset(JSON.stringify({ ...imported, dataset: { ...imported.dataset, name: "changed" } }), "json"))
      .rejects.toBeInstanceOf(DatasetIdentityConflictError);
    await expect(service.importDataset(JSON.stringify({ ...imported, data: [] }), "json"))
      .rejects.toBeInstanceOf(DatasetIdentityConflictError);
    await expect(service.getDataset(imported.dataset.datasetId)).resolves.toEqual(imported.dataset);
    expect(store.data.size).toBe(2);
  });

  it("rejects an invalid reference before generating IDs or issuing a Store import", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const importDataset = vi.spyOn(store, "importDataset");
    const generateId = vi.spyOn(crypto, "randomUUID");
    try {
      await expect(service.importDataset(JSON.stringify({
        dataset: { name: "tasks" },
        data: [{ userPrompt: "task", initialMaterials: [{ bundleId: "debddf36-3eeb-41c6-819b-b1f75e365dc2" }] }],
      }), "json")).rejects.toBeInstanceOf(DatasetInputError);
      expect(importDataset).not.toHaveBeenCalled();
      expect(generateId).not.toHaveBeenCalled();
    } finally {
      generateId.mockRestore();
    }
  });

  it("exports through one consistent Store snapshot without separate Dataset/Data reads", async () => {
    const store = new TestDatasetStore();
    const service = createDatasetService(store);
    const imported = await service.importDataset(JSON.stringify({
      dataset: { name: "tasks" },
      data: [{ userPrompt: "task", initialSession, initialMaterials }],
    }), "json");
    const readSnapshot = vi.spyOn(store, "getDatasetSnapshot");
    const getDataset = vi.spyOn(store, "getDataset");
    const listData = vi.spyOn(store, "listData");
    const exported = parseDatasetDocument(await service.exportDataset(imported.dataset.datasetId, "yaml"), "yaml");
    expect(exported).toEqual(imported);
    expect(readSnapshot).toHaveBeenCalledExactlyOnceWith(imported.dataset.datasetId);
    expect(getDataset).not.toHaveBeenCalled();
    expect(listData).not.toHaveBeenCalled();
  });
});
