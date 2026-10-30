import {
  DatasetEntityNotFoundError,
  dataSchema,
  initialMaterialsRefsSchema,
  initialSessionRefSchema,
  type Data,
  type InitialMaterialsRef,
} from "@eval-platform/eval-dataset";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { digestJson } from "@eval-platform/eval-runtime";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { EvalDb } from "./db/client.js";
import { requireOwnerUserId } from "./db/owner.js";
import { assertDataReferencesSelectable, materialReferenceByteSize } from "./db/resource-catalog.js";
import { data, datasetData, datasets, managementOperations } from "./db/schema.js";

/** Each present field replaces (references) or clears (`null`) one whole initial resource field of a Data row. */
export const dataInitialResourcePatchSchema = z.strictObject({
  initialMaterials: initialMaterialsRefsSchema.nullable().exactOptional(),
  evalInitialMaterials: initialMaterialsRefsSchema.nullable().exactOptional(),
  initialSession: initialSessionRefSchema.nullable().exactOptional(),
}).refine((patch) => Object.keys(patch).length > 0, "Specify initialMaterials, evalInitialMaterials or initialSession");

export type DataInitialResourcePatch = z.output<typeof dataInitialResourcePatchSchema>;

/** Only the management bind supplies this guard; ordinary HTTP PATCH remains compatible. */
export interface BindPrecondition {
  readonly datasetId: string;
  readonly expectedContentDigest: string;
  readonly resultContentDigest: string;
  /** Only a previously attempted stage may reconcile an already-written result. */
  readonly replay?: boolean;
  /** A confirmed stage may only read back, never restore a later edit. */
  readonly confirmed?: boolean;
}

export interface InitialResourceApi {
  bindData(dataId: string, patch: DataInitialResourcePatch, precondition?: BindPrecondition): Promise<Data>;
  /** The locked preflight cannot substitute for the atomic check in bindData. */
  inspectBindTarget(datasetId: string, dataId: string, expectedContentDigest: string,
    attemptedResultDigest?: string): Promise<Data>;
  /** Measure every existing selection, including retained soft deletes, from the locked owned Data and catalog. */
  preflightBindMaterialBytes(datasetId: string, dataId: string, expectedContentDigest: string,
    references: { readonly initialMaterials?: readonly InitialMaterialsRef[];
      readonly evalInitialMaterials?: readonly InitialMaterialsRef[] }): Promise<{
    readonly data: Data;
    readonly byteSizes: { readonly initialMaterials: readonly number[]; readonly evalInitialMaterials: readonly number[] };
  }>;
}

/** Preserve every business field, including opaque Data metadata, while replacing only present resource fields. */
export function patchedInitialResources(current: Data, patch: DataInitialResourcePatch): Data {
  const next: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(patch)) {
    if (value) next[field] = value;
    else delete next[field];
  }
  return dataSchema.parse(next);
}

type Writer = Parameters<Parameters<EvalDb["transaction"]>[0]>[0];
/** Shared row-locked owner/membership/upstream guard for the management reservation and atomic Data update. */
export async function lockedBindTarget(
  transaction: Writer, ownerUserId: string, datasetId: string, dataId: string,
): Promise<Data> {
  const owner = requireOwnerUserId(ownerUserId);
  // Dataset-first locking serializes detach/attach/soft deletion with this membership check.
  const [dataset] = await transaction.select({ datasetId: datasets.datasetId }).from(datasets)
    .where(and(eq(datasets.ownerUserId, owner), eq(datasets.datasetId, datasetId),
      isNull(datasets.deletedAt))).for("update");
  if (!dataset) throw new DatasetEntityNotFoundError("dataset", datasetId);
  const [row] = await transaction.select({ content: data.content }).from(data)
    .where(and(eq(data.ownerUserId, owner), eq(data.dataId, dataId),
      isNull(data.deletedAt))).for("update");
  if (!row) throw new DatasetEntityNotFoundError("data", dataId);
  const [member] = await transaction.select({ dataId: datasetData.dataId }).from(datasetData)
    .where(and(eq(datasetData.ownerUserId, owner), eq(datasetData.datasetId, datasetId),
      eq(datasetData.dataId, dataId))).limit(1);
  if (!member) throw new DatasetEntityNotFoundError("data", dataId);
  const [preparing] = await transaction.select({ key: managementOperations.operationKey }).from(managementOperations)
    .where(and(eq(managementOperations.ownerUserId, owner), eq(managementOperations.kind, "prepare"),
      eq(managementOperations.status, "pending"),
      eq(sql<string>`${managementOperations.plan}->>'datasetId'`, datasetId))).limit(1);
  if (preparing) throw new HttpError("EVAL_SP_CONFLICT", "The Dataset preparation is not ready");
  return dataSchema.parse({ ...row.content, dataId });
}

async function checkedBindTarget(transaction: Writer, owner: string, datasetId: string, dataId: string,
  expectedContentDigest: string, attemptedResultDigest?: string): Promise<Data> {
  const current = await lockedBindTarget(transaction, owner, datasetId, dataId);
  const digest = await digestJson(current);
  if (digest !== expectedContentDigest && digest !== attemptedResultDigest) {
    throw new HttpError("EVAL_SP_CONFLICT", "The original Data content changed");
  }
  return current;
}

/** Binds existing owner-scoped catalog entries to a Data row. */
export function createInitialResourceApi(db: EvalDb, ownerUserId: string): InitialResourceApi {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    async inspectBindTarget(datasetId, dataId, expectedContentDigest, attemptedResultDigest) {
      return db.transaction((transaction) =>
        checkedBindTarget(transaction, owner, datasetId, dataId, expectedContentDigest, attemptedResultDigest));
    },
    async preflightBindMaterialBytes(datasetId, dataId, expectedContentDigest, references) {
      return db.transaction(async (transaction) => {
        const current = await checkedBindTarget(transaction, owner, datasetId, dataId, expectedContentDigest);
        const byteSizes = { initialMaterials: [] as number[], evalInitialMaterials: [] as number[] };
        for (const field of ["initialMaterials", "evalInitialMaterials"] as const) {
          for (const reference of references[field] ?? []) {
            byteSizes[field].push(await materialReferenceByteSize(transaction, owner, field, reference, current));
          }
        }
        return { data: current, byteSizes };
      });
    },
    async bindData(dataId, patch, precondition) {
      const replacement = dataInitialResourcePatchSchema.parse(patch);
      return db.transaction(async (transaction) => {
        const current = precondition ? await lockedBindTarget(transaction, owner, precondition.datasetId, dataId)
          : await (async () => {
            const [row] = await transaction.select({ content: data.content }).from(data)
              .where(and(eq(data.ownerUserId, owner), eq(data.dataId, dataId),
                isNull(data.deletedAt))).for("update");
            if (!row) throw new DatasetEntityNotFoundError("data", dataId);
            return dataSchema.parse({ ...row.content, dataId });
          })();
        const currentDigest = precondition ? await digestJson(current) : undefined;
        if (precondition) {
          if (currentDigest === precondition.resultContentDigest
            && currentDigest !== precondition.expectedContentDigest && precondition.replay) return current;
          if ((precondition.confirmed && currentDigest !== precondition.resultContentDigest)
            || currentDigest !== precondition.expectedContentDigest) {
            throw new HttpError("EVAL_SP_CONFLICT", "The Data changed since binding was reviewed");
          }
        }
        const updated = patchedInitialResources(current, replacement);
        if (precondition && await digestJson(updated) !== precondition.resultContentDigest) {
          throw new HttpError("EVAL_SP_CONFLICT", "The planned Data content changed");
        }
        // Validate the *whole* next Data, not just patched fields: unchanged references may be
        // retained after soft deletion, but every new selection and each role's full byte budget must pass.
        await assertDataReferencesSelectable(transaction, owner, updated, current);
        if (precondition && currentDigest === precondition.resultContentDigest) return current;
        const { dataId: _dataId, ...content } = updated;
        await transaction.update(data).set({ content })
          .where(and(eq(data.ownerUserId, owner), eq(data.dataId, dataId)));
        return updated;
      });
    },
  };
}
