import { createDatasetService, DatasetEntityNotFoundError, DatasetIdentityConflictError } from "@eval-platform/eval-dataset";
import { digestJson } from "@eval-platform/eval-runtime";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresManagementStore } from "../eval-management/store.js";
import { createProjectService } from "../projects/service.js";
import { bindProjectSamples } from "../projects/snapshot.js";
import { createPostgresDatasetStore, readDatasetSnapshots } from "./dataset.js";
import { createPostgresProjectStore } from "./project-store.js";
import { data as dataTable, datasetData, managementOperations } from "./schema.js";
import { createTestDatabase } from "./test-database.js";

const connection = process.env.DATABASE_URL;
const OWNER = "membership-owner";
const OTHER = "foreign-owner";
const FIRST = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SECOND = "11111111-1111-4111-8111-111111111111";
const THIRD = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe.skipIf(!connection)("PostgreSQL Dataset upload order and bounded management membership", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase(connection!);
  }, 30_000);

  beforeEach(async () => {
    await database.db.execute(sql`TRUNCATE TABLE eval_management_operations, eval_datasets, eval_data CASCADE`);
  });

  afterAll(async () => {
    if (database) await database.destroy();
  }, 30_000);

  const prompt = {
    name: "Uploaded tasks", description: "Cases", format: "jsonl" as const,
    content: [
      { name: "First", description: "a", userPrompt: "private first", evalPrompt: "judge first" },
      { name: "Second", description: "b", userPrompt: "private second", evalPrompt: "judge second" },
    ].map((row) => JSON.stringify(row)).join("\n"),
  };

  function services(owner = OWNER) {
    const db = database.db;
    const projectStore = createPostgresProjectStore(db, owner);
    return {
      datasets: createDatasetService(createPostgresDatasetStore(db, owner)),
      members: createPostgresManagementStore(db),
      projectStore,
      projects: createProjectService({
        ownerUserId: owner, sourceBranch: "test-only", store: projectStore,
        outputSchemas: { get: async () => null },
        agentConfigs: { freeze: async () => { throw new Error("No Agent copies in a selection read"); },
          discard: async () => {} },
        admission: { preview: async () => { throw new Error("No Runs in a selection read"); },
          submit: async () => { throw new Error("No Runs in a selection read"); } },
      }),
    };
  }

  async function importPlanned() {
    const datasetId = crypto.randomUUID();
    const dataset = await services().datasets.importPromptDataset(prompt, { datasetId, dataIds: [FIRST, SECOND] });
    return dataset;
  }

  async function legacyMembers(datasetId: string) {
    // Models rows written by the already-applied migration prefix: no historical order was stored.
    await database.db.update(datasetData).set({ position: null }).where(eq(datasetData.datasetId, datasetId));
  }

  async function insertOldPreparation(datasetId: string, dataIds: readonly string[] = [FIRST, SECOND],
    status: "pending" | "completed" = "completed", ownerUserId = OWNER) {
    await database.db.insert(managementOperations).values({
      ownerUserId, operationKey: crypto.randomUUID(), kind: "prepare",
      fingerprint: "a".repeat(64), status,
      plan: { version: 1, datasetId, dataIds, promptUploadRef: crypto.randomUUID(),
        name: prompt.name, description: prompt.description, format: prompt.format,
        cases: dataIds.map(() => ({})), assets: [] },
      stages: { dataset: { status: "confirmed", receipt: { datasetId, dataIds } },
        ...Object.fromEntries(dataIds.map((dataId) => [`data:${dataId}`, {
          status: "confirmed", receipt: { dataId },
        }])) },
    });
  }

  it("persists file row 1 ahead of a smaller UUID in all Dataset/Project reads and keeps the first replay order", async () => {
    const { datasets, members, projectStore, projects } = services();
    const imported = await importPlanned();
    const id = imported.dataset.datasetId;
    expect(imported.data.map((item) => item.dataId)).toEqual([FIRST, SECOND]);
    expect((await database.db.select().from(datasetData).where(eq(datasetData.datasetId, id)))
      .map(({ dataId, position }) => ({ dataId, position })).sort((a, b) => a.position! - b.position!))
      .toEqual([{ dataId: FIRST, position: 0 }, { dataId: SECOND, position: 1 }]);
    expect((await datasets.listData(id)).map((row) => row.dataId)).toEqual([FIRST, SECOND]);
    expect((await readDatasetSnapshots(database.db, OWNER, [id]))[0]?.data.map((row) => row.dataId))
      .toEqual([FIRST, SECOND]);
    expect(JSON.parse(await datasets.exportDataset(id, "json")).data.map((row: { dataId: string }) => row.dataId))
      .toEqual([FIRST, SECOND]);
    expect(await members.listDatasetData(OWNER, id, 1, 5)).toMatchObject({
      name: prompt.name, order: "upload", total: 2,
      items: [{ dataId: FIRST }, { dataId: SECOND }],
    });
    const selection = { datasetId: id };
    const [selected] = await projectStore.readSelection([selection]);
    const reviewed = await projects.reviewSelection(selection);
    expect(selected?.data.map((row) => row.dataId)).toEqual([FIRST, SECOND]);
    expect(reviewed.data).toEqual(selected?.data);
    expect(reviewed.digest).toBe(await digestJson({ dataset: selected!.dataset, selected: selected!.data }));
    const frozen = bindProjectSamples({ projectId: crypto.randomUUID(), datasets: [selected!], samplingCountOf: () => 1 });
    expect(frozen.samples.map((row) => row.dataId)).toEqual([FIRST, SECOND]);
    expect(frozen.datasets[0]?.projectSampleIds).toEqual(frozen.samples.map((row) => row.projectSampleId));

    const reversed = { dataset: imported.dataset, data: [...imported.data].reverse() };
    await expect(datasets.importDataset(JSON.stringify(reversed), "json")).rejects.toBeInstanceOf(DatasetIdentityConflictError);
    // A general import cannot change a Prompt Dataset's kind. An identical planned Prompt replay is non-mutating.
    await expect(datasets.importPromptDataset(prompt, { datasetId: id, dataIds: [FIRST, SECOND] })).resolves.toEqual(imported);
    expect((await datasets.listData(id)).map((row) => row.dataId)).toEqual([FIRST, SECOND]);

    const third = await datasets.createData({ name: "Third", description: "c", userPrompt: "private third", evalPrompt: "judge third" });
    await expect(datasets.attachData(id, [SECOND, third.dataId, THIRD]))
      .rejects.toBeInstanceOf(DatasetEntityNotFoundError); // Missing ID rolls back the entire attach.
    expect((await datasets.listData(id)).map((row) => row.dataId)).toEqual([FIRST, SECOND]);
  });

  it("orders new generic imports, batches, single creates and idempotent attaches without resequencing members", async () => {
    const { datasets, members } = services();
    const id = crypto.randomUUID();
    const original = { dataset: { datasetId: id, name: "Generic" },
      data: [{ dataId: FIRST, name: "First", userPrompt: "a" }, { dataId: SECOND, name: "Second", userPrompt: "b" }] };
    await datasets.importDataset(JSON.stringify(original), "json");
    await expect(datasets.importDataset(JSON.stringify({ ...original, data: [...original.data].reverse() }), "json"))
      .rejects.toBeInstanceOf(DatasetIdentityConflictError); // A changed upload order is not the same Dataset snapshot.
    expect((await members.listDatasetData(OWNER, id, 1, 5)).order).toBe("upload");
    const third = await datasets.createData({ userPrompt: "third" }, { datasetId: id });
    const added = await datasets.addData(id, [{ userPrompt: "fourth" }, { userPrompt: "fifth" }]);
    const detached = await datasets.createData({ userPrompt: "last" });
    await expect(datasets.attachData(id, [THIRD, detached.dataId]))
      .rejects.toBeInstanceOf(DatasetEntityNotFoundError); // Invalid ID must not attach the other ID.
    expect((await datasets.listData(id)).map((row) => row.dataId)).toEqual([
      FIRST, SECOND, third.dataId, ...added.map((item) => item.dataId),
    ]);
    await datasets.attachData(id, [SECOND, detached.dataId, detached.dataId]);
    expect((await datasets.listData(id)).map((row) => row.dataId)).toEqual([
      FIRST, SECOND, third.dataId, ...added.map((item) => item.dataId), detached.dataId,
    ]);
    await datasets.detachData(id, [FIRST]);
    await datasets.attachData(id, [FIRST]);
    expect((await datasets.listData(id)).map((row) => row.dataId)).toEqual([
      SECOND, third.dataId, ...added.map((item) => item.dataId), detached.dataId, FIRST,
    ]);
    // Once new members are added, the old import cannot replace the complete membership set.
    await expect(datasets.importDataset(JSON.stringify(original), "json"))
      .rejects.toBeInstanceOf(DatasetIdentityConflictError);
    expect((await members.listDatasetData(OWNER, id, 1, 5)).order).toBe("upload");
  });

  it("recovers an old completed Moss plan only for the same owner and full membership", async () => {
    const imported = await importPlanned();
    const id = imported.dataset.datasetId;
    await legacyMembers(id);
    const { datasets, members, projectStore, projects } = services();
    expect((await members.listDatasetData(OWNER, id, 1, 5)).order).toBe("unknown");
    await insertOldPreparation(id);
    expect(await members.listDatasetData(OWNER, id, 1, 5)).toMatchObject({
      order: "upload", total: 2, items: [{ dataId: FIRST }, { dataId: SECOND }],
    });
    expect((await datasets.listData(id)).map((row) => row.dataId)).toEqual([FIRST, SECOND]);
    expect((await projectStore.readSelection([{ datasetId: id }]))[0]?.data.map((row) => row.dataId))
      .toEqual([FIRST, SECOND]);
    expect((await projects.reviewSelection({ datasetId: id })).digest).toBe(await digestJson({
      dataset: (await projectStore.readSelection([{ datasetId: id }]))[0]!.dataset,
      selected: (await projectStore.readSelection([{ datasetId: id }]))[0]!.data,
    }));
    expect((await database.db.select().from(datasetData).where(eq(datasetData.datasetId, id)))
      .every((row) => row.position === null)).toBe(true); // No fabricated backfill.
    const extra = await datasets.createData({ name: "Extra", description: "c", userPrompt: "new", evalPrompt: "judge" });
    await datasets.attachData(id, [extra.dataId]);
    const changed = await members.listDatasetData(OWNER, id, 1, 5);
    expect(changed).toMatchObject({ order: "unknown", total: 3 });
    expect(changed.items.map((item) => item.dataId)).toEqual([SECOND, FIRST, extra.dataId]);
  });

  it("never invents row 1 for legacy UI imports, partial preparation, foreign or deleted Datasets", async () => {
    const imported = await importPlanned();
    const id = imported.dataset.datasetId;
    await legacyMembers(id);
    const { datasets, members } = services();
    expect(await members.listDatasetData(OWNER, id, 1, 5)).toMatchObject({
      order: "unknown", items: [{ dataId: SECOND }, { dataId: FIRST }],
    });
    await insertOldPreparation(id, [FIRST, SECOND], "pending");
    await expect(members.listDatasetData(OWNER, id, 1, 5)).rejects.toMatchObject({ code: "EVAL_SP_CONFLICT" });
    await database.db.update(managementOperations).set({ status: "completed", plan: { version: 1, datasetId: id,
      dataIds: [FIRST], cases: [{}], assets: [] } });
    expect((await members.listDatasetData(OWNER, id, 1, 5)).order).toBe("unknown");
    await expect(members.listDatasetData(OTHER, id, 1, 5)).rejects.toMatchObject({ code: "DATASET_NOT_FOUND" });
    await datasets.deleteDataset(id);
    await expect(members.listDatasetData(OWNER, id, 1, 5)).rejects.toMatchObject({ code: "DATASET_NOT_FOUND" });
  });

  it("pages all 34 identities but not prompts, with a per-Dataset unique known position", async () => {
    const { datasets, members } = services();
    const content = Array.from({ length: 34 }, (_, index) => JSON.stringify({
      name: `Case ${index + 1}`, description: "safe", userPrompt: `PRIVATE_USER_${index}`,
      evalPrompt: `PRIVATE_EVAL_${index}`, url: "https://private.invalid",
    })).join("\n");
    const imported = await datasets.importPromptDataset({ ...prompt, content });
    const datasetId = imported.dataset.datasetId;
    const page = await members.listDatasetData(OWNER, datasetId, 1, 5);
    expect(page).toMatchObject({ order: "upload", total: 34 });
    expect(page.items.map((row) => row.dataId)).toEqual(imported.data.slice(0, 5).map((row) => row.dataId));
    expect(page.items).toHaveLength(5);
    expect((await members.listDatasetData(OWNER, datasetId, 7, 5)).items).toHaveLength(4);
    await expect(database.db.update(datasetData).set({ position: 0 })
      .where(and(eq(datasetData.datasetId, datasetId), eq(datasetData.dataId, imported.data[1]!.dataId))))
      .rejects.toThrow();
    expect((await database.db.select({ position: datasetData.position }).from(datasetData)
      .where(eq(datasetData.datasetId, datasetId))).every((row) => row.position !== null)).toBe(true);
    expect((await database.db.select().from(dataTable)).length).toBe(34);
  });
});
