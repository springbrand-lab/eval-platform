import { equalJson } from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import {
  dataSchema, datasetSchema, initialMaterialsRefsSchema, initialSessionRefSchema, platformIdSchema,
  type Data, type Dataset, type InitialMaterialsRef, type InitialSessionRef,
} from "@eval-platform/eval-dataset";
import { digestJson } from "@eval-platform/eval-runtime";
import { and, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { IMPORT_LIMITS } from "../agent-imports/model.js";
import { READ_SNAPSHOT, type EvalDb } from "../db/client.js";
import { orderDatasetMemberships } from "../db/dataset.js";
import type { DatasetMemberOrder } from "../db/dataset-order.js";
import { data, datasetData, datasets, managementOperations, managementUploads } from "../db/schema.js";
import { assertDataReferencesSelectable } from "../db/resource-catalog.js";
import { lockedBindTarget, patchedInitialResources } from "../initial-resources.js";
import { validBatchBindingPlan, validBatchBindingStages } from "./binding-plan.js";
import { validPreparationPlan, validPreparationStages } from "./preparation-plan.js";

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

/** Only the three validated, stored reference fields; never a Data body or catalog activity claim. */
export interface DatasetDataResources {
  readonly initialMaterials: readonly InitialMaterialsRef[];
  readonly evalInitialMaterials: readonly InitialMaterialsRef[];
  readonly initialSession: InitialSessionRef | null;
}

export interface PreparedDatasetSnapshot {
  readonly dataset: Dataset;
  readonly order: DatasetMemberOrder;
  /** Raw JSONB content digests, before any Data schema could normalize a stored reference. */
  readonly data: readonly { readonly dataId: string; readonly contentDigest: string }[];
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
  /** One owner-scoped, read-only snapshot, including current membership order and soft-deletion proof. */
  inspectPreparedDataset(owner: string, datasetId: string): Promise<PreparedDatasetSnapshot | null>;
  /** Same snapshot for active owner, pending-preparation fence, order proof, total and page. */
  listDatasetData(owner: string, datasetId: string, page: number, pageSize: number): Promise<DatasetDataPage>;
  /** Direct, owner-scoped active Dataset/Data/member read with the same pending fence; no Dataset-wide scan. */
  readDatasetDataResources(owner: string, datasetId: string, dataId: string): Promise<DatasetDataResources>;
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
      .where(and(eq(managementOperations.ownerUserId, owner), inArray(managementOperations.kind, ["prepare", "bind"]),
        eq(managementOperations.status, "pending"),
        inArray(sql<string>`${managementOperations.plan}->>'datasetId'`, [...ids]))).limit(1);
    if (pending) throw new HttpError("EVAL_SP_CONFLICT", "Finish the pending Data preparation or binding");
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
        ? [plan.promptUploadRef]
        : kind === "initial_resource" ? [(plan.asset as { uploadRef?: unknown } | undefined)?.uploadRef]
        : kind === "bind" ? []
        : kind === "output_schema" ? [] : [plan.uploadRef];
      const parsed = refs.map((ref) => platformIdSchema.parse(ref)).sort();
      if (parsed.length > 101 || new Set(parsed).size !== parsed.length) throw conflict();
      // Only Skills claim names: the existing output Schema catalog permits duplicate names.
      const claimedSkillName = kind === "skill" ? skillName ?? null : null;
      return db.transaction(async (transaction) => {
        if (kind === "bind") {
          // Dataset first, then every Data in sorted order. This also serializes a v4 claim
          // with legacy v3 keys and overlapping v4 batches across different Datasets.
          const datasetId = platformIdSchema.parse(plan.datasetId);
          const batch = plan.version === 4;
          if (batch && !validBatchBindingPlan(owner, operationKey, fingerprint, plan)) throw conflict();
          const ids = batch
            ? (plan.bindings as { dataId: string }[]).map(({ dataId }) => dataId)
            : [platformIdSchema.parse(plan.dataId)];
          const originals = new Map<string, Data>();
          for (const dataId of [...ids].sort()) {
            originals.set(dataId, await lockedBindTarget(transaction, owner, datasetId, dataId));
          }
          const [sameKey] = await transaction.select({ key: managementOperations.operationKey }).from(managementOperations)
            .where(operationWhere(owner, operationKey)).limit(1);
          const [pending] = await transaction.select({ key: managementOperations.operationKey }).from(managementOperations)
            .where(and(eq(managementOperations.ownerUserId, owner), eq(managementOperations.kind, "bind"),
              eq(managementOperations.status, "pending"),
              ne(managementOperations.operationKey, operationKey),
              or(inArray(sql<string>`${managementOperations.plan}->>'dataId'`, ids),
                ...ids.map((id) => sql<boolean>`${managementOperations.plan}->'bindings' @> ${JSON.stringify([{ dataId: id }])}::jsonb`))))
            .limit(1);
          if (pending) throw conflict();
          if (!sameKey) {
            for (const [index, dataId] of ids.entries()) {
              const expected = batch ? (plan.bindings as { expectedContentDigest: string }[])[index]!.expectedContentDigest
                : plan.expectedContentDigest;
              if (await digestJson(originals.get(dataId)!) !== expected) throw conflict();
            }
          }
        }
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
      const [candidate] = await db.select().from(managementOperations).where(operationWhere(owner, operationKey));
      if (!candidate) throw missing();
      if (candidate.kind === "bind" && candidate.plan.version === 4) {
        const plan = candidate.plan;
        if (!validBatchBindingPlan(owner, operationKey, candidate.fingerprint, plan)) throw conflict();
        await db.transaction(async (transaction) => {
          // Use the same Dataset -> sorted Data -> operation lock order as begin.
          // A forged/early stage receipt cannot mark an uncommitted batch complete.
          const actual = new Map<string, Data>();
          for (const dataId of plan.bindings.map(({ dataId }) => dataId).sort()) {
            actual.set(dataId, await lockedBindTarget(transaction, owner, plan.datasetId, dataId));
          }
          const [row] = await transaction.select().from(managementOperations)
            .where(operationWhere(owner, operationKey)).for("update");
          if (!row || row.kind !== "bind" || row.fingerprint !== candidate.fingerprint
            || !equalJson(row.plan, plan)
            || !validBatchBindingStages(plan, row.stages, true)) throw conflict();
          for (const { dataId, contentDigest, patch } of plan.bindings) {
            const member = actual.get(dataId)!;
            if (await digestJson(member) !== contentDigest
              || await digestJson(patchedInitialResources(member, patch)) !== contentDigest) throw conflict();
            // Completion cannot accept a forged/early confirmed no-op stage
            // with an unmet patch, invalid references or an over-budget field.
            await assertDataReferencesSelectable(transaction, owner, member, member);
          }
          if (row.status !== "completed") await transaction.update(managementOperations)
            .set({ status: "completed" }).where(operationWhere(owner, operationKey));
        });
        return;
      }
      await locked(owner, operationKey, async (row, transaction) => {
        if (row.kind === "prepare" && (!validPreparationPlan(owner, operationKey, row.fingerprint, row.plan)
          || !validPreparationStages(row.plan, row.stages, true))) {
          throw conflict();
        }
        if (row.kind === "bind" && (row.plan.version === 4
          ? !validBatchBindingPlan(owner, operationKey, row.fingerprint, row.plan)
            || !validBatchBindingStages(row.plan, row.stages, true)
          : row.plan.version !== 3 || typeof row.plan.dataId !== "string" || Array.isArray(row.plan.dataIds))) {
          throw conflict();
        }
        if (row.kind === "initial_resource" && (row.plan.version !== 1
          || !row.plan.asset || typeof row.plan.asset !== "object"
          || typeof (row.plan.asset as { uploadRef?: unknown }).uploadRef !== "string")) throw conflict();
        const required = row.kind === "skill" ? ["skill"] : row.kind === "reference" ? ["attachment", "reference"]
          : row.kind === "output_schema" ? ["output_schema"]
            : row.kind === "initial_resource" ? [`resource:${(row.plan.asset as { uploadRef: string }).uploadRef}`]
              : row.kind === "bind" ? [row.plan.version === 4 ? "batch" : `data:${row.plan.dataId}`]
                : ["dataset", ...(row.plan.dataIds as string[]).map((id) => `data:${id}`)];
        if (required.includes("") || required.some((stage) => row.stages[stage]?.status !== "confirmed")) throw conflict();
        if (row.status !== "completed") await transaction.update(managementOperations)
          .set({ status: "completed" }).where(operationWhere(owner, operationKey));
      });
    },
    async assertReadyDatasets(owner, ids) {
      await assertReady(db, owner, ids);
    },
    async inspectPreparedDataset(owner, datasetId) {
      return db.transaction(async (transaction) => {
        // Metadata is read only from the owner. An ID-only exclusion check rejects
        // foreign collisions instead of mistaking them for an absent Dataset.
        const [stored] = await transaction.select({
          datasetId: datasets.datasetId, ownerUserId: datasets.ownerUserId,
          name: datasets.name, description: datasets.description, kind: datasets.kind,
          deletedAt: datasets.deletedAt, originalOrderIntact: datasets.originalOrderIntact,
        }).from(datasets).where(and(eq(datasets.ownerUserId, owner), eq(datasets.datasetId, datasetId))).limit(1);
        if (!stored) {
          const [claimed] = await transaction.select({ datasetId: datasets.datasetId }).from(datasets)
            .where(eq(datasets.datasetId, datasetId)).limit(1);
          if (claimed) throw conflict();
          return null;
        }
        if (stored.deletedAt !== null || stored.kind !== "prompt" || stored.originalOrderIntact !== true) throw conflict();
        const parsed = datasetSchema.safeParse({
          datasetId: stored.datasetId, name: stored.name,
          ...(stored.description === null ? {} : { description: stored.description }),
        });
        // A schema parse can trim a stored name. Replay must compare the *actual*
        // database label, not a normalized projection that hides a later edit.
        if (!parsed.success || parsed.data.name !== stored.name) throw conflict();
        const members = await transaction.select({
          datasetId: datasetData.datasetId, dataId: datasetData.dataId, position: datasetData.position,
          content: data.content, dataOwner: data.ownerUserId, deletedAt: data.deletedAt,
        }).from(datasetData).leftJoin(data, and(
          eq(data.dataId, datasetData.dataId), eq(data.ownerUserId, datasetData.ownerUserId),
        )).where(and(eq(datasetData.ownerUserId, owner), eq(datasetData.datasetId, datasetId))).limit(51);
        if (members.length === 0 || members.length > 50 || members.some((row) =>
          row.dataOwner !== owner || row.deletedAt !== null || row.content === null)) throw conflict();
        const ordered = (await orderDatasetMemberships(transaction, owner, [stored], members)).get(datasetId)!;
        if (ordered.order !== "upload") throw conflict();
        const rows = await Promise.all(ordered.members.map(async (row) => {
          if (row.content === null) throw conflict();
          const parsedRow = dataSchema.safeParse({ ...row.content, dataId: row.dataId });
          if (!parsedRow.success) throw conflict();
          return { dataId: row.dataId, contentDigest: await digestJson(row.content) };
        }));
        return { dataset: parsed.data, order: ordered.order, data: rows };
      }, READ_SNAPSHOT);
    },
    async listDatasetData(owner, datasetId, page, pageSize) {
      if (!Number.isSafeInteger(page) || page < 1 || page > 10_000
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 20) {
        throw new HttpError("REQUEST_INVALID_INPUT", "Select a page of at most twenty Data");
      }
      return db.transaction(async (transaction) => {
        const [dataset] = await transaction.select({
          datasetId: datasets.datasetId, kind: datasets.kind, name: datasets.name,
          originalOrderIntact: datasets.originalOrderIntact,
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
    async readDatasetDataResources(owner, datasetId, dataId) {
      const selectedDataset = platformIdSchema.safeParse(datasetId);
      const selectedData = platformIdSchema.safeParse(dataId);
      if (!selectedDataset.success || !selectedData.success) {
        throw new HttpError("REQUEST_INVALID_INPUT", "Select a Dataset and Data UUID");
      }
      return db.transaction(async (transaction) => {
        const [dataset] = await transaction.select({ datasetId: datasets.datasetId }).from(datasets)
          .where(and(eq(datasets.ownerUserId, owner), eq(datasets.datasetId, selectedDataset.data),
            isNull(datasets.deletedAt))).limit(1);
        if (!dataset) throw new HttpError("DATASET_NOT_FOUND");
        await assertReady(transaction, owner, [dataset.datasetId]);

        // The (dataset_id, data_id) membership PK targets exactly one Data. Project
        // only the three JSONB reference fields: no prompt, business data, uploadRef
        // or Bundle contents are read, even into this private Store result.
        const [member] = await transaction.select({
          contentIsObject: sql<boolean>`jsonb_typeof(${data.content}) = 'object'`,
          initialMaterials: sql<unknown>`${data.content}->'initialMaterials'`,
          evalInitialMaterials: sql<unknown>`${data.content}->'evalInitialMaterials'`,
          initialSession: sql<unknown>`${data.content}->'initialSession'`,
        }).from(datasetData).innerJoin(data, and(
          eq(data.ownerUserId, datasetData.ownerUserId),
          eq(data.dataId, datasetData.dataId), isNull(data.deletedAt),
        )).where(and(eq(datasetData.ownerUserId, owner), eq(datasetData.datasetId, dataset.datasetId),
          eq(datasetData.dataId, selectedData.data))).limit(1);
        if (!member) throw new HttpError("DATA_NOT_FOUND");
        if (!member.contentIsObject) throw new HttpError("RESPONSE_INVALID", "Stored Data content is invalid");
        // A Data can belong to several Datasets. A pending v3/v4 bind via a
        // different Dataset still makes this member's current bindings uncertain.
        const [pendingBind] = await transaction.select({ operationKey: managementOperations.operationKey })
          .from(managementOperations).where(and(eq(managementOperations.ownerUserId, owner),
            eq(managementOperations.kind, "bind"), eq(managementOperations.status, "pending"),
            or(eq(sql<string>`${managementOperations.plan}->>'dataId'`, selectedData.data),
              sql<boolean>`${managementOperations.plan}->'bindings' @> ${
                JSON.stringify([{ dataId: selectedData.data }])
              }::jsonb`))).limit(1);
        if (pendingBind) throw new HttpError("EVAL_SP_CONFLICT", "Finish the pending Data binding");

        const initialMaterials = initialMaterialsRefsSchema.nullish().safeParse(member.initialMaterials);
        const evalInitialMaterials = initialMaterialsRefsSchema.nullish().safeParse(member.evalInitialMaterials);
        const initialSession = initialSessionRefSchema.nullish().safeParse(member.initialSession);
        if (!initialMaterials.success || !evalInitialMaterials.success || !initialSession.success) {
          throw new HttpError("RESPONSE_INVALID", "Stored Data resource references are invalid");
        }
        return {
          initialMaterials: initialMaterials.data ?? [],
          evalInitialMaterials: evalInitialMaterials.data ?? [],
          initialSession: initialSession.data ?? null,
        };
      }, READ_SNAPSHOT);
    },
  };
}
