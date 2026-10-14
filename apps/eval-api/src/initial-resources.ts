import {
  DatasetEntityNotFoundError,
  dataIdSchema,
  dataSchema,
  initialMaterialsRefSchema,
  initialSessionRefSchema,
  type Data,
  type InitialMaterialsRef,
  type InitialSessionRef,
} from "@eval-platform/eval-dataset";
import { and, eq } from "drizzle-orm";
import type { EvalDb } from "./db/client.js";
import { requireOwnerUserId } from "./db/owner.js";
import { data } from "./db/schema.js";
import type { BundleDirectory, MaterialFile, SessionContent } from "./sp/bundle-directory.js";

export interface DataInitialResourcePatch {
  readonly initialMaterials?: InitialMaterialsRef | null;
  readonly initialSession?: InitialSessionRef | null;
}

/** Authenticated API composition: upload resources separately, then bind existing ones to a Data. */
export function createInitialResourceApi(db: EvalDb, ownerUserId: string, bundles: BundleDirectory) {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    async uploadMaterials(reference: InitialMaterialsRef, files: readonly MaterialFile[]): Promise<InitialMaterialsRef> {
      const selected = initialMaterialsRefSchema.parse(reference);
      await bundles.uploadInitialMaterials(owner, selected, files);
      return selected;
    },
    async uploadSession(reference: InitialSessionRef, context: SessionContent): Promise<InitialSessionRef> {
      const selected = initialSessionRefSchema.parse(reference);
      await bundles.uploadInitialSession(owner, selected, context);
      return selected;
    },
    async bindData(dataId: string, patch: DataInitialResourcePatch): Promise<Data> {
      if (!patch || typeof patch !== "object" || Array.isArray(patch) ||
        Object.keys(patch).length === 0 || Object.keys(patch).some((key) =>
          key !== "initialMaterials" && key !== "initialSession") ||
        (Object.hasOwn(patch, "initialMaterials") && patch.initialMaterials === undefined) ||
        (Object.hasOwn(patch, "initialSession") && patch.initialSession === undefined)) {
        throw new TypeError("Initial resource binding must specify materials or Session");
      }
      const selectedId = dataIdSchema.parse(dataId);
      const materials = patch.initialMaterials === undefined || patch.initialMaterials === null
        ? patch.initialMaterials : initialMaterialsRefSchema.parse(patch.initialMaterials);
      const session = patch.initialSession === undefined || patch.initialSession === null
        ? patch.initialSession : initialSessionRefSchema.parse(patch.initialSession);
      if (materials) await bundles.resolveInitialMaterials(owner, materials);
      return db.transaction(async (transaction) => {
        const [row] = await transaction.select({ content: data.content }).from(data)
          .where(and(eq(data.ownerUserId, owner), eq(data.dataId, selectedId))).for("update");
        if (!row) throw new DatasetEntityNotFoundError("data", selectedId);
        const next: Record<string, unknown> = { ...row.content };
        if (Object.hasOwn(patch, "initialMaterials")) {
          if (materials) next.initialMaterials = materials;
          else delete next.initialMaterials;
        }
        if (Object.hasOwn(patch, "initialSession")) {
          if (session) next.initialSession = session;
          else delete next.initialSession;
        }
        const updated = dataSchema.parse({ ...next, dataId: selectedId });
        const { dataId: _dataId, ...content } = updated;
        await transaction.update(data).set({ content })
          .where(and(eq(data.ownerUserId, owner), eq(data.dataId, selectedId)));
        return updated;
      });
    },
  };
}
