import { isDeepStrictEqual } from "node:util";
import type { Data, Dataset, DatasetSnapshot, DatasetStore } from "@eval-platform/eval-dataset";
import {
  DataInUseError,
  DatasetEntityNotFoundError,
  DatasetIdentityConflictError,
  assertPromptData,
  assertPromptDatasetMetadata,
  dataSchema,
  datasetSchema,
} from "@eval-platform/eval-dataset";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { READ_SNAPSHOT, type EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { assertDataReferencesSelectable } from "./resource-catalog.js";
import { data, datasetData, datasets } from "./schema.js";

type DatasetReader = Pick<EvalDb, "select">;
type DatasetWriter = Parameters<Parameters<EvalDb["transaction"]>[0]>[0];

async function lockDataset(transaction: DatasetWriter, ownerUserId: string, datasetId: string) {
  const [dataset] = await transaction.select({ datasetId: datasets.datasetId, kind: datasets.kind }).from(datasets)
    .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, datasetId),
      isNull(datasets.deletedAt))).for("update");
  if (!dataset) throw new DatasetEntityNotFoundError("dataset", datasetId);
  return dataset;
}

function datasetFromRow(row: typeof datasets.$inferSelect): Dataset {
  return datasetSchema.parse({
    datasetId: row.datasetId,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
  });
}

function dataFromRow(row: Pick<typeof data.$inferSelect, "dataId" | "content">): Data {
  return dataSchema.parse({ ...row.content, dataId: row.dataId });
}

function dataContent(record: Data): Omit<Data, "dataId"> {
  const { dataId: _dataId, ...content } = record;
  return content;
}

export async function readDatasetSnapshots(
  reader: DatasetReader,
  ownerUserId: string,
  datasetIds: readonly string[],
): Promise<readonly DatasetSnapshot[]> {
  if (datasetIds.length === 0) return [];
  const rows = await reader.select().from(datasets)
    .where(and(eq(datasets.ownerUserId, ownerUserId), inArray(datasets.datasetId, datasetIds),
      isNull(datasets.deletedAt)))
    .orderBy(datasets.datasetId);
  if (rows.length === 0) return [];
  const members = await reader.select({ datasetId: datasetData.datasetId, dataId: data.dataId, content: data.content })
    .from(datasetData)
    .innerJoin(data, and(eq(datasetData.dataId, data.dataId), eq(data.ownerUserId, datasetData.ownerUserId)))
    .where(and(eq(datasetData.ownerUserId, ownerUserId), inArray(datasetData.datasetId, rows.map((row) => row.datasetId))))
    .orderBy(datasetData.datasetId, data.dataId);
  const dataByDataset = new Map<string, Data[]>();
  for (const member of members) {
    const entries = dataByDataset.get(member.datasetId) ?? [];
    entries.push(dataFromRow(member));
    dataByDataset.set(member.datasetId, entries);
  }
  return rows.map((row) => ({
    dataset: datasetFromRow(row),
    data: dataByDataset.get(row.datasetId) ?? [],
  }));
}

export function createPostgresDatasetStore(db: EvalDb, ownerUserId: string): DatasetStore {
  requireOwnerUserId(ownerUserId);
  return {
    async createDataset(dataset) {
      const record = datasetSchema.parse(dataset);
      const inserted = await db.insert(datasets).values({
        datasetId: record.datasetId, ownerUserId, kind: "general", name: record.name, description: record.description ?? null,
      }).onConflictDoNothing().returning({ datasetId: datasets.datasetId });
      if (inserted.length === 0) throw new DatasetIdentityConflictError("dataset", record.datasetId);
    },
    async updateDataset(dataset) {
      const record = datasetSchema.parse(dataset);
      await db.transaction(async (transaction) => {
        const current = await lockDataset(transaction, ownerUserId, record.datasetId);
        if (current.kind === "prompt") assertPromptDatasetMetadata(record);
        await transaction.update(datasets).set({ name: record.name, description: record.description ?? null })
          .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, record.datasetId)));
      });
    },
    async getDataset(datasetId) {
      const [row] = await db.select().from(datasets)
        .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, datasetId),
          isNull(datasets.deletedAt)));
      return row ? datasetFromRow(row) : null;
    },
    async listDatasets() {
      const rows = await db.select().from(datasets)
        .where(and(eq(datasets.ownerUserId, ownerUserId), isNull(datasets.deletedAt)))
        .orderBy(datasets.datasetId);
      return rows.map(datasetFromRow);
    },
    async deleteDataset(datasetId) {
      await db.transaction(async (transaction) => {
        const [row] = await transaction.select({ datasetId: datasets.datasetId }).from(datasets)
          .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, datasetId),
            isNull(datasets.deletedAt))).for("update");
        if (!row) return;
        await transaction.update(datasets).set({ deletedAt: new Date() })
          .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, datasetId)));
      });
    },
    async createData(record, options) {
      const entry = dataSchema.parse(record);
      await db.transaction(async (transaction) => {
        const target = options?.datasetId === undefined ? null : await lockDataset(transaction, ownerUserId, options.datasetId);
        if (target?.kind === "prompt") assertPromptData(entry);
        await assertDataReferencesSelectable(transaction, ownerUserId, entry);
        const inserted = await transaction.insert(data).values({
          dataId: entry.dataId, ownerUserId, content: dataContent(entry),
        }).onConflictDoNothing().returning({ dataId: data.dataId });
        if (inserted.length === 0) throw new DatasetIdentityConflictError("data", entry.dataId);
        if (target) await transaction.insert(datasetData).values({ ownerUserId, datasetId: target.datasetId, dataId: entry.dataId });
      });
    },
    async updateData(record) {
      const entry = dataSchema.parse(record);
      await db.transaction(async (transaction) => {
        await assertDataReferencesSelectable(transaction, ownerUserId, entry);
        const [current] = await transaction.select({ dataId: data.dataId }).from(data)
          .where(and(eq(data.ownerUserId, ownerUserId), eq(data.dataId, entry.dataId),
            isNull(data.deletedAt))).for("update");
        if (!current) throw new DatasetEntityNotFoundError("data", entry.dataId);
        const [promptMember] = await transaction.select({ datasetId: datasets.datasetId })
          .from(datasetData).innerJoin(datasets, and(
            eq(datasetData.ownerUserId, datasets.ownerUserId),
            eq(datasetData.datasetId, datasets.datasetId),
          )).where(and(eq(datasetData.ownerUserId, ownerUserId), eq(datasetData.dataId, entry.dataId),
            eq(datasets.kind, "prompt"), isNull(datasets.deletedAt))).limit(1);
        if (promptMember) assertPromptData(entry);
        await transaction.update(data).set({ content: dataContent(entry) })
          .where(and(eq(data.ownerUserId, ownerUserId), eq(data.dataId, entry.dataId)));
      });
    },
    async getData(dataId) {
      const [row] = await db.select().from(data)
        .where(and(eq(data.ownerUserId, ownerUserId), eq(data.dataId, dataId),
          isNull(data.deletedAt)));
      return row ? dataFromRow(row) : null;
    },
    async listData(datasetId) {
      if (datasetId === undefined) {
        const rows = await db.select().from(data).where(and(eq(data.ownerUserId, ownerUserId),
          isNull(data.deletedAt))).orderBy(data.dataId);
        return rows.map(dataFromRow);
      }
      return db.transaction(async (transaction) => {
        const snapshot = (await readDatasetSnapshots(transaction, ownerUserId, [datasetId]))[0];
        if (!snapshot) throw new DatasetEntityNotFoundError("dataset", datasetId);
        return snapshot.data;
      }, READ_SNAPSHOT);
    },
    async deleteData(dataId) {
      await db.transaction(async (transaction) => {
        const [row] = await transaction.select({ dataId: data.dataId }).from(data)
          .where(and(eq(data.ownerUserId, ownerUserId), eq(data.dataId, dataId),
            isNull(data.deletedAt))).for("update");
        if (!row) return;
        const [member] = await transaction.select({ dataId: datasetData.dataId }).from(datasetData)
          .innerJoin(datasets, and(eq(datasetData.datasetId, datasets.datasetId),
            eq(datasetData.ownerUserId, datasets.ownerUserId)))
          .where(and(eq(datasetData.ownerUserId, ownerUserId), eq(datasetData.dataId, dataId),
            isNull(datasets.deletedAt))).limit(1);
        if (member) throw new DataInUseError(dataId);
        await transaction.update(data).set({ deletedAt: new Date() })
          .where(and(eq(data.ownerUserId, ownerUserId), eq(data.dataId, dataId)));
      });
    },
    async attachData(datasetId, dataIds) {
      await db.transaction(async (transaction) => {
        const dataset = await lockDataset(transaction, ownerUserId, datasetId);
        const uniqueIds = [...new Set(dataIds)].sort();
        if (uniqueIds.length === 0) return;
        const existing = await transaction.select({ dataId: data.dataId, content: data.content }).from(data)
          .where(and(eq(data.ownerUserId, ownerUserId), inArray(data.dataId, uniqueIds),
            isNull(data.deletedAt)))
          .orderBy(data.dataId).for("share");
        const found = new Set(existing.map((row) => row.dataId));
        const missing = uniqueIds.find((id) => !found.has(id));
        if (missing) throw new DatasetEntityNotFoundError("data", missing);
        if (dataset.kind === "prompt") {
          for (const row of existing) assertPromptData(dataFromRow(row));
        }
        await transaction.insert(datasetData).values(uniqueIds.map((dataId) => ({ ownerUserId, datasetId, dataId })))
          .onConflictDoNothing();
      });
    },
    async detachData(datasetId, dataIds) {
      await db.transaction(async (transaction) => {
        const [dataset] = await transaction.select({ datasetId: datasets.datasetId }).from(datasets)
          .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, datasetId),
            isNull(datasets.deletedAt))).for("update");
        if (!dataset) throw new DatasetEntityNotFoundError("dataset", datasetId);
        if (dataIds.length > 0) {
          await transaction.delete(datasetData).where(and(
            eq(datasetData.ownerUserId, ownerUserId),
            eq(datasetData.datasetId, datasetId), inArray(datasetData.dataId, dataIds),
          ));
        }
      });
    },
    async getDatasetSnapshot(datasetId) {
      return db.transaction(
        async (transaction) => (await readDatasetSnapshots(transaction, ownerUserId, [datasetId]))[0] ?? null,
        READ_SNAPSHOT,
      );
    },
    async importDataset(snapshot, options) {
      await db.transaction(async (transaction) => {
        const incoming = datasetSchema.parse(snapshot.dataset);
        const kind = options?.kind ?? "general";
        if (kind === "prompt") assertPromptDatasetMetadata(incoming);
        const [locked] = await transaction.select().from(datasets)
          .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, incoming.datasetId))).for("update");
        let existing = locked;
        let created = false;
        if (!existing) {
          const [inserted] = await transaction.insert(datasets).values({
            datasetId: incoming.datasetId, ownerUserId, kind,
            name: incoming.name, description: incoming.description ?? null,
          }).onConflictDoNothing().returning();
          created = inserted !== undefined;
          existing = inserted ?? (await transaction.select().from(datasets)
            .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, incoming.datasetId))).for("update"))[0];
        }
        if (!existing || existing.deletedAt !== null || existing.kind !== kind ||
          !isDeepStrictEqual(datasetFromRow(existing), incoming)) {
          throw new DatasetIdentityConflictError("dataset", incoming.datasetId);
        }

        const incomingData = snapshot.data.map((entry) => dataSchema.parse(entry))
          .sort((left, right) => left.dataId.localeCompare(right.dataId));
        for (const entry of incomingData) {
          if (kind === "prompt") assertPromptData(entry);
          await assertDataReferencesSelectable(transaction, ownerUserId, entry);
        }
        const seenIds = new Set<string>();
        for (const entry of incomingData) {
          if (seenIds.has(entry.dataId)) throw new DatasetIdentityConflictError("data", entry.dataId);
          seenIds.add(entry.dataId);
        }
        for (const entry of incomingData) {
          const [lockedData] = await transaction.select().from(data)
            .where(and(eq(data.ownerUserId, ownerUserId), eq(data.dataId, entry.dataId))).for("update");
          let existingData = lockedData;
          if (!existingData) {
            const [inserted] = await transaction.insert(data).values({
              dataId: entry.dataId, ownerUserId, content: dataContent(entry),
            }).onConflictDoNothing().returning();
            existingData = inserted ?? (await transaction.select().from(data)
              .where(and(eq(data.ownerUserId, ownerUserId), eq(data.dataId, entry.dataId))).for("update"))[0];
          }
          if (!existingData || existingData.deletedAt !== null || !isDeepStrictEqual(dataFromRow(existingData), entry)) {
            throw new DatasetIdentityConflictError("data", entry.dataId);
          }
        }

        const existingMembers = await transaction.select({ dataId: datasetData.dataId })
          .from(datasetData).where(and(eq(datasetData.ownerUserId, ownerUserId), eq(datasetData.datasetId, incoming.datasetId)))
          .orderBy(datasetData.dataId);
        if (!created) {
          if (!isDeepStrictEqual(existingMembers.map((member) => member.dataId), incomingData.map((entry) => entry.dataId))) {
            throw new DatasetIdentityConflictError("dataset", incoming.datasetId);
          }
        } else if (incomingData.length > 0) {
          await transaction.insert(datasetData).values(incomingData.map((entry) => ({
            ownerUserId, datasetId: incoming.datasetId, dataId: entry.dataId,
          })));
        }
      });
    },
  };
}
