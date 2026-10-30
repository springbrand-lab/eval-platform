import { equalJson } from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { platformIdSchema, type Data } from "@eval-platform/eval-dataset";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { IMPORT_LIMITS } from "../agent-imports/model.js";
import { READ_SNAPSHOT, type EvalDb } from "../db/client.js";
import { orderDatasetMemberships } from "../db/dataset.js";
import type { DatasetMemberOrder } from "../db/dataset-order.js";
import { data, datasetData, datasets, managementOperations, managementUploads } from "../db/schema.js";

export type UploadKind = typeof managementUploads.$inferInsert.kind;
export type OperationKind = typeof managementOperations.$inferInsert.kind;
export type UploadReceipt = typeof managementUploads.$inferSelect;
export type OperationReceipt = typeof managementOperations.$inferSelect;
type Stage = OperationReceipt["stages"][string];
export type StageClaim = { status: "started" } | { status: "attempted" } | { status: "confirmed"; receipt: unknown };

/** Internal read result; only the allowlisted, redacted name is exposed by list_options. */
export interface DatasetDataPage {
  readonly name: string;
  readonly order: DatasetMemberOrder;
  readonly total: number;
  readonly items: readonly { readonly dataId: string; readonly content: Omit<Data, "dataId"> }[];
}

/** Persistent reservations and write-ahead receipts; no SP work takes place inside a DB transaction. */
export interface ManagementStore {
  reserveUpload(owner: string, uploadId: string, metadata: {
    kind: UploadKind; name: string; mediaType: string; byteSize: number; sha256: string; expiresAt: Date;
  }): Promise<void>;
  releaseUpload(owner: string, uploadId: string): Promise<void>;
  readyUpload(owner: string, uploadId: string): Promise<void>;
  upload(owner: string, uploadId: string): Promise<UploadReceipt | null>;
  begin(owner: string, operationKey: string, kind: OperationKind, fingerprint: string,
    plan: Record<string, unknown>, skillName?: string): Promise<OperationReceipt>;
  get(owner: string, operationKey: string): Promise<OperationReceipt | null>;
  attempt(owner: string, operationKey: string, stage: string): Promise<StageClaim>;
  confirm(owner: string, operationKey: string, stage: string, receipt: unknown): Promise<void>;
  complete(owner: string, operationKey: string): Promise<void>;
  assertReadyDatasets(owner: string, ids: readonly string[]): Promise<void>;
  /** Same snapshot for active owner, pending-preparation fence, order proof, total and page. */
  listDatasetData(owner: string, datasetId: string, page: number, pageSize: number): Promise<DatasetDataPage>;
}

const conflict = () => new HttpError("EVAL_SP_CONFLICT", "The operation key or resource is already claimed");
const missing = () => new HttpError("REQUEST_NOT_FOUND", "The operation is not available");

export function createPostgresManagementStore(db: EvalDb): ManagementStore {
  const operationWhere = (owner: string, key: string) =>
    and(eq(managementOperations.ownerUserId, owner), eq(managementOperations.operationKey, key));
  const uploadWhere = (owner: string, id: string) =>
    and(eq(managementUploads.ownerUserId, owner), eq(managementUploads.uploadId, id));

  async function assertReady(reader: Pick<EvalDb, "select">, owner: string, ids: readonly string[]): Promise<void> {
    const [pending] = await reader.select({ operationKey: managementOperations.operationKey }).from(managementOperations)
      .where(and(eq(managementOperations.ownerUserId, owner), eq(managementOperations.kind, "prepare"),
        eq(managementOperations.status, "pending"),
        inArray(sql<string>`${managementOperations.plan}->>'datasetId'`, [...ids]))).limit(1);
    if (pending) throw new HttpError("EVAL_SP_CONFLICT", "Bind all prepared Data before creating a Project");
  }

  async function locked(owner: string, key: string, callback: (row: OperationReceipt,
    transaction: Parameters<Parameters<EvalDb["transaction"]>[0]>[0]) => Promise<void>): Promise<void> {
    await db.transaction(async (transaction) => {
      const [row] = await transaction.select().from(managementOperations)
        .where(operationWhere(owner, key)).for("update");
      if (!row) throw missing();
      await callback(row, transaction);
    });
  }

  return {
    async reserveUpload(owner, uploadId, metadata) {
      await db.transaction(async (transaction) => {
        // One database-wide reservation lock: concurrent API instances cannot exceed the private root budget.
        await transaction.execute(sql`SELECT pg_advisory_xact_lock(17926007)`);
        const now = new Date();
        await transaction.delete(managementUploads).where(and(
          lte(managementUploads.expiresAt, now), isNull(managementUploads.claimedBy),
        ));
        const [usage] = await transaction.select({
          bytes: sql<string>`coalesce(sum(${managementUploads.byteSize}), 0)`,
          reserved: sql<string>`count(*) FILTER (WHERE ${managementUploads.status} = 'reserved')`,
        }).from(managementUploads).where(gt(managementUploads.expiresAt, now));
        if (Number(usage?.reserved ?? 0) >= 8) {
          throw new HttpError("REQUEST_RATE_LIMITED", "Too many simultaneous management uploads");
        }
        if (Number(usage?.bytes ?? 0) + metadata.byteSize > IMPORT_LIMITS.stagingBytes) {
          throw new HttpError("REQUEST_PAYLOAD_TOO_LARGE", "Upload staging is full");
        }
        const [inserted] = await transaction.insert(managementUploads).values({
          ownerUserId: owner, uploadId, ...metadata, status: "reserved",
        }).onConflictDoNothing().returning({ uploadId: managementUploads.uploadId });
        if (!inserted) throw conflict(); // Never reuse a reserved/READY ID or rewrite its file.
      });
    },
    async releaseUpload(owner, uploadId) {
      await db.delete(managementUploads).where(and(uploadWhere(owner, uploadId), eq(managementUploads.status, "reserved")));
    },
    async readyUpload(owner, uploadId) {
      const [saved] = await db.update(managementUploads).set({ status: "ready" })
        .where(and(uploadWhere(owner, uploadId), eq(managementUploads.status, "reserved")))
        .returning({ uploadId: managementUploads.uploadId });
      if (!saved) throw missing();
    },
    async upload(owner, uploadId) {
      const [row] = await db.select().from(managementUploads)
        .where(and(uploadWhere(owner, uploadId), eq(managementUploads.status, "ready")));
      return row ?? null;
    },
    async begin(owner, operationKey, kind, fingerprint, plan, skillName) {
      const refs = kind === "prepare"
        ? [plan.promptUploadRef, ...(Array.isArray(plan.assets) ? plan.assets.map((asset) =>
          asset && typeof asset === "object" && "uploadRef" in asset ? asset.uploadRef : null) : [])]
        : kind === "output_schema" ? [] : [plan.uploadRef];
      const parsed = refs.map((ref) => platformIdSchema.parse(ref)).sort();
      if (parsed.length > 101 || new Set(parsed).size !== parsed.length) throw conflict();
      // Only Skills claim names: the existing output Schema catalog permits duplicate names.
      const claimedSkillName = kind === "skill" ? skillName ?? null : null;
      return db.transaction(async (transaction) => {
        await transaction.insert(managementOperations).values({
          ownerUserId: owner, operationKey, kind, fingerprint, plan,
          skillName: claimedSkillName, stages: {}, status: "pending",
        }).onConflictDoNothing();
        const [current] = await transaction.select().from(managementOperations)
          .where(operationWhere(owner, operationKey)).for("update");
        if (!current || current.kind !== kind || current.fingerprint !== fingerprint ||
          current.skillName !== claimedSkillName || !equalJson(current.plan, plan)) throw conflict();
        for (const ref of parsed) {
          const [claimed] = await transaction.update(managementUploads).set({ claimedBy: operationKey })
            .where(and(uploadWhere(owner, ref), eq(managementUploads.status, "ready"),
              or(isNull(managementUploads.claimedBy), eq(managementUploads.claimedBy, operationKey))))
            .returning({ uploadId: managementUploads.uploadId });
          if (!claimed) throw conflict();
        }
        return current;
      });
    },
    async get(owner, operationKey) {
      const [row] = await db.select().from(managementOperations).where(operationWhere(owner, operationKey));
      return row ?? null;
    },
    async attempt(owner, operationKey, stage) {
      let claimed: StageClaim = { status: "attempted" };
      await locked(owner, operationKey, async (row, transaction) => {
        const entry = row.stages[stage];
        if (entry?.status === "confirmed") {
          claimed = { status: "confirmed", receipt: entry.receipt };
          return;
        }
        if (entry?.status === "attempted" || row.status === "completed") return;
        await transaction.update(managementOperations)
          .set({ stages: { ...row.stages, [stage]: { status: "attempted" } satisfies Stage } })
          .where(operationWhere(owner, operationKey));
        claimed = { status: "started" };
      });
      return claimed;
    },
    async confirm(owner, operationKey, stage, receipt) {
      await locked(owner, operationKey, async (row, transaction) => {
        const entry = row.stages[stage];
        if (entry?.status === "confirmed") {
          if (!equalJson(entry.receipt, receipt)) throw conflict();
          return;
        }
        if (entry?.status !== "attempted" || row.status === "completed") throw conflict();
        await transaction.update(managementOperations)
          .set({ stages: { ...row.stages, [stage]: { status: "confirmed", receipt } satisfies Stage } })
          .where(operationWhere(owner, operationKey));
      });
    },
    async complete(owner, operationKey) {
      await locked(owner, operationKey, async (row, transaction) => {
        if (row.kind === "prepare" && (!Array.isArray(row.plan.assets) || !Array.isArray(row.plan.dataIds))) {
          throw conflict();
        }
        const required = row.kind === "skill" ? ["skill"] : row.kind === "reference" ? ["attachment", "reference"]
          : row.kind === "output_schema" ? ["output_schema"]
            : ["dataset", ...(Array.isArray(row.plan.assets) ? row.plan.assets.map((asset) =>
            asset && typeof asset === "object" && "uploadRef" in asset ? `resource:${asset.uploadRef}` : "") : []),
          ...(Array.isArray(row.plan.dataIds) ? row.plan.dataIds.map((id) => `data:${id}`) : [])];
        if (required.includes("") || required.some((stage) => row.stages[stage]?.status !== "confirmed")) throw conflict();
        if (row.status !== "completed") await transaction.update(managementOperations)
          .set({ status: "completed" }).where(operationWhere(owner, operationKey));
      });
    },
    async assertReadyDatasets(owner, ids) {
      await assertReady(db, owner, ids);
    },
    async listDatasetData(owner, datasetId, page, pageSize) {
      if (!Number.isSafeInteger(page) || page < 1 || page > 10_000
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 5) {
        throw new HttpError("REQUEST_INVALID_INPUT", "Select a page of at most five Data");
      }
      return db.transaction(async (transaction) => {
        const [dataset] = await transaction.select({
          datasetId: datasets.datasetId, kind: datasets.kind, name: datasets.name,
        }).from(datasets).where(and(eq(datasets.ownerUserId, owner), eq(datasets.datasetId, datasetId),
          isNull(datasets.deletedAt)));
        if (!dataset) throw new HttpError("DATASET_NOT_FOUND");
        await assertReady(transaction, owner, [datasetId]);
        const bound = await transaction.select({
          datasetId: datasetData.datasetId, dataId: datasetData.dataId, position: datasetData.position,
        }).from(datasetData).where(and(eq(datasetData.ownerUserId, owner), eq(datasetData.datasetId, datasetId)));
        const ordered = (await orderDatasetMemberships(transaction, owner, [dataset], bound)).get(datasetId)!;
        const total = ordered.members.length;
        const ids = ordered.members.slice((page - 1) * pageSize, page * pageSize).map(({ dataId }) => dataId);
        const items = ids.length ? await transaction.select({ dataId: data.dataId, content: data.content })
          .from(data).where(and(eq(data.ownerUserId, owner), inArray(data.dataId, ids), isNull(data.deletedAt))) : [];
        const byId = new Map(items.map((item) => [item.dataId, item]));
        if (byId.size !== ids.length) throw new HttpError("RESPONSE_INVALID", "Dataset has a missing Data member");
        return { name: dataset.name, order: ordered.order, total, items: ids.map((id) => byId.get(id)!) };
      }, READ_SNAPSHOT);
    },
  };
}
