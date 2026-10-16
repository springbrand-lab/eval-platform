import {
  DatasetEntityNotFoundError,
  dataSchema,
  initialMaterialsRefsSchema,
  initialSessionRefSchema,
  type Data,
} from "@eval-platform/eval-dataset";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { EvalDb } from "./db/client.js";
import { requireOwnerUserId } from "./db/owner.js";
import { assertDataReferencesSelectable } from "./db/resource-catalog.js";
import { data } from "./db/schema.js";

/** Each present field replaces (references) or clears (`null`) one whole initial resource field of a Data row. */
export const dataInitialResourcePatchSchema = z.strictObject({
  initialMaterials: initialMaterialsRefsSchema.nullable().exactOptional(),
  evalInitialMaterials: initialMaterialsRefsSchema.nullable().exactOptional(),
  initialSession: initialSessionRefSchema.nullable().exactOptional(),
}).refine((patch) => Object.keys(patch).length > 0, "Specify initialMaterials, evalInitialMaterials or initialSession");

export type DataInitialResourcePatch = z.output<typeof dataInitialResourcePatchSchema>;

export interface InitialResourceApi {
  bindData(dataId: string, patch: DataInitialResourcePatch): Promise<Data>;
}

/** Binds existing owner-scoped catalog entries to a Data row. */
export function createInitialResourceApi(db: EvalDb, ownerUserId: string): InitialResourceApi {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    async bindData(dataId, patch) {
      return db.transaction(async (transaction) => {
        await assertDataReferencesSelectable(transaction, owner, patch);
        const [row] = await transaction.select({ content: data.content }).from(data)
          .where(and(eq(data.ownerUserId, owner), eq(data.dataId, dataId),
            isNull(data.deletedAt))).for("update");
        if (!row) throw new DatasetEntityNotFoundError("data", dataId);
        const next: Record<string, unknown> = { ...row.content };
        for (const [field, value] of Object.entries(patch)) {
          if (value) next[field] = value;
          else delete next[field];
        }
        const updated = dataSchema.parse({ ...next, dataId });
        const { dataId: _dataId, ...content } = updated;
        await transaction.update(data).set({ content })
          .where(and(eq(data.ownerUserId, owner), eq(data.dataId, dataId)));
        return updated;
      });
    },
  };
}
