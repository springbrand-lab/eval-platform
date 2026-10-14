import { isDeepStrictEqual } from "node:util";
import type { Data, Dataset, DatasetSnapshot, DatasetStore } from "@eval-platform/eval-dataset";
import {
  DataInUseError,
  DatasetEntityNotFoundError,
  DatasetIdentityConflictError,
  dataSchema,
  datasetSchema,
} from "@eval-platform/eval-dataset";
import { and, eq, inArray } from "drizzle-orm";
import { isForeignKeyFailure, type EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { data, datasetData, datasets } from "./schema.js";

type DatasetReader = Pick<EvalDb, "select">;

export class DatasetInUseError extends Error {
  constructor(readonly datasetId: string) {
    super(`Dataset is still referenced: ${datasetId}`);
    this.name = "DatasetInUseError";
  }
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
    .where(and(eq(datasets.ownerUserId, ownerUserId), inArray(datasets.datasetId, datasetIds)))
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
        datasetId: record.datasetId, ownerUserId, name: record.name, description: record.description ?? null,
      }).onConflictDoNothing().returning({ datasetId: datasets.datasetId });
      if (inserted.length === 0) throw new DatasetIdentityConflictError("dataset", record.datasetId);
    },
    async updateDataset(dataset) {
      const record = datasetSchema.parse(dataset);
      const updated = await db.update(datasets)
        .set({ name: record.name, description: record.description ?? null })
        .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, record.datasetId)))
        .returning({ datasetId: datasets.datasetId });
      if (updated.length === 0) throw new DatasetEntityNotFoundError("dataset", record.datasetId);
    },
    async getDataset(datasetId) {
      const [row] = await db.select().from(datasets)
        .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, datasetId)));
      return row ? datasetFromRow(row) : null;
    },
    async listDatasets() {
      const rows = await db.select().from(datasets)
        .where(eq(datasets.ownerUserId, ownerUserId)).orderBy(datasets.datasetId);
      return rows.map(datasetFromRow);
    },
    async deleteDataset(datasetId) {
      try {
        await db.delete(datasets).where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, datasetId)));
      } catch (error) {
        if (isForeignKeyFailure(error)) throw new DatasetInUseError(datasetId);
        throw error;
      }
    },
    async createData(record) {
      const entry = dataSchema.parse(record);
      const inserted = await db.insert(data).values({ dataId: entry.dataId, ownerUserId, content: dataContent(entry) })
        .onConflictDoNothing().returning({ dataId: data.dataId });
      if (inserted.length === 0) throw new DatasetIdentityConflictError("data", entry.dataId);
    },
    async updateData(record) {
      const entry = dataSchema.parse(record);
      const updated = await db.update(data).set({ content: dataContent(entry) })
        .where(and(eq(data.ownerUserId, ownerUserId), eq(data.dataId, entry.dataId)))
        .returning({ dataId: data.dataId });
      if (updated.length === 0) throw new DatasetEntityNotFoundError("data", entry.dataId);
    },
    async getData(dataId) {
      const [row] = await db.select().from(data)
        .where(and(eq(data.ownerUserId, ownerUserId), eq(data.dataId, dataId)));
      return row ? dataFromRow(row) : null;
    },
    async listData(datasetId) {
      if (datasetId === undefined) {
        const rows = await db.select().from(data).where(eq(data.ownerUserId, ownerUserId)).orderBy(data.dataId);
        return rows.map(dataFromRow);
      }
      return db.transaction(async (transaction) => {
        const snapshot = (await readDatasetSnapshots(transaction, ownerUserId, [datasetId]))[0];
        if (!snapshot) throw new DatasetEntityNotFoundError("dataset", datasetId);
        return snapshot.data;
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
    async deleteData(dataId) {
      try {
        await db.delete(data).where(and(eq(data.ownerUserId, ownerUserId), eq(data.dataId, dataId)));
      } catch (error) {
        if (isForeignKeyFailure(error)) throw new DataInUseError(dataId);
        throw error;
      }
    },
    async attachData(datasetId, dataIds) {
      await db.transaction(async (transaction) => {
        const [dataset] = await transaction.select({ datasetId: datasets.datasetId }).from(datasets)
          .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, datasetId))).for("update");
        if (!dataset) throw new DatasetEntityNotFoundError("dataset", datasetId);
        const uniqueIds = [...new Set(dataIds)].sort();
        if (uniqueIds.length === 0) return;
        const existing = await transaction.select({ dataId: data.dataId }).from(data)
          .where(and(eq(data.ownerUserId, ownerUserId), inArray(data.dataId, uniqueIds)))
          .orderBy(data.dataId).for("key share");
        const found = new Set(existing.map((row) => row.dataId));
        const missing = uniqueIds.find((id) => !found.has(id));
        if (missing) throw new DatasetEntityNotFoundError("data", missing);
        await transaction.insert(datasetData).values(uniqueIds.map((dataId) => ({ ownerUserId, datasetId, dataId })))
          .onConflictDoNothing();
      });
    },
    async detachData(datasetId, dataIds) {
      await db.transaction(async (transaction) => {
        const [dataset] = await transaction.select({ datasetId: datasets.datasetId }).from(datasets)
          .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, datasetId))).for("update");
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
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
    async importDataset(snapshot) {
      await db.transaction(async (transaction) => {
        const incoming = datasetSchema.parse(snapshot.dataset);
        const [locked] = await transaction.select().from(datasets)
          .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, incoming.datasetId))).for("update");
        let existing = locked;
        let created = false;
        if (!existing) {
          const [inserted] = await transaction.insert(datasets).values({
            datasetId: incoming.datasetId, ownerUserId, name: incoming.name, description: incoming.description ?? null,
          }).onConflictDoNothing().returning();
          created = inserted !== undefined;
          existing = inserted ?? (await transaction.select().from(datasets)
            .where(and(eq(datasets.ownerUserId, ownerUserId), eq(datasets.datasetId, incoming.datasetId))).for("update"))[0];
        }
        if (!existing || !isDeepStrictEqual(datasetFromRow(existing), incoming)) {
          throw new DatasetIdentityConflictError("dataset", incoming.datasetId);
        }

        const incomingData = snapshot.data.map((entry) => dataSchema.parse(entry))
          .sort((left, right) => left.dataId.localeCompare(right.dataId));
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
          if (!existingData || !isDeepStrictEqual(dataFromRow(existingData), entry)) {
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
