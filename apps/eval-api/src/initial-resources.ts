import {
  DatasetEntityNotFoundError,
  dataSchema,
  initialMaterialsRefSchema,
  initialSessionRefSchema,
  type Data,
} from "@eval-platform/eval-dataset";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { EvalDb } from "./db/client.js";
import { requireOwnerUserId } from "./db/owner.js";
import { assertMaterialSelectable, assertSessionSelectable } from "./db/resource-catalog.js";
import { data } from "./db/schema.js";

/** Each present field binds (reference) or clears (`null`) one initial resource of a Data row. */
export const dataInitialResourcePatchSchema = z.strictObject({
  initialMaterials: initialMaterialsRefSchema.nullable().exactOptional(),
  evalInitialMaterials: initialMaterialsRefSchema.nullable().exactOptional(),
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
      const { initialMaterials: materials, evalInitialMaterials: evalMaterials, initialSession: session } = patch;
      return db.transaction(async (transaction) => {
        if (materials) await assertMaterialSelectable(transaction, owner, materials);
        if (evalMaterials) await assertMaterialSelectable(transaction, owner, evalMaterials);
        if (session) await assertSessionSelectable(transaction, owner, session);
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
