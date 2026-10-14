import type { InitialMaterialsRef, InitialSessionRef } from "@eval-platform/eval-dataset";
import { and, eq, isNull } from "drizzle-orm";
import type { BundleDirectory, MaterialFile, SessionContent } from "../sp/bundle-directory.js";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { catalogId, parseCatalogMetadataPatch, requiredCatalogLabel, type CatalogMetadataPatch } from "./output-schemas.js";
import { bundleMaterials, bundleSessions, bundles } from "./schema.js";

export interface BundleRecord {
  readonly bundleId: string;
  readonly name: string;
  readonly description: string;
}

export interface MaterialRecord {
  readonly bundleId: string;
  readonly materialId: string;
  readonly name: string;
  readonly description: string;
}

export interface SessionRecord {
  readonly bundleId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly description: string;
  readonly format: "json" | "jsonl";
}

export class BundleResourceNotFoundError extends Error {
  constructor(kind: "Bundle" | "Material" | "Session", id: string) {
    super(`Unknown ${kind} ${id}`);
    this.name = "BundleResourceNotFoundError";
  }
}

function bundleRecord(row: typeof bundles.$inferSelect): BundleRecord {
  return { bundleId: row.bundleId, name: row.name, description: row.description };
}

function materialRecord(row: typeof bundleMaterials.$inferSelect): MaterialRecord {
  return { bundleId: row.bundleId, materialId: row.materialId, name: row.name, description: row.description };
}

function sessionRecord(row: typeof bundleSessions.$inferSelect): SessionRecord {
  return { bundleId: row.bundleId, sessionId: row.sessionId, name: row.name,
    description: row.description, format: row.format };
}

/** Owner-scoped Bundle metadata. Bytes remain in BundleDirectory, untouched by soft deletes. */
export function createResourceCatalog(db: EvalDb, ownerUserId: string, directory: BundleDirectory) {
  const owner = requireOwnerUserId(ownerUserId);
  const activeBundle = (bundleId: string) => and(
    eq(bundles.ownerUserId, owner), eq(bundles.bundleId, catalogId(bundleId)), isNull(bundles.deletedAt),
  );
  async function requireBundle(bundleId: string): Promise<BundleRecord> {
    const [row] = await db.select().from(bundles).where(activeBundle(bundleId));
    if (!row) throw new BundleResourceNotFoundError("Bundle", bundleId);
    return bundleRecord(row);
  }
  return {
    async createBundle(input: { name: string; description: string }): Promise<BundleRecord> {
      const row = { bundleId: crypto.randomUUID(), ownerUserId: owner,
        name: requiredCatalogLabel(input.name, "name"),
        description: requiredCatalogLabel(input.description, "description") };
      await db.insert(bundles).values(row);
      return bundleRecord({ ...row, deletedAt: null });
    },
    async listBundles(): Promise<readonly BundleRecord[]> {
      return (await db.select().from(bundles).where(and(
        eq(bundles.ownerUserId, owner), isNull(bundles.deletedAt),
      )).orderBy(bundles.bundleId)).map(bundleRecord);
    },
    getBundle: requireBundle,
    async updateBundle(bundleId: string, input: CatalogMetadataPatch): Promise<BundleRecord> {
      const id = catalogId(bundleId);
      const [row] = await db.update(bundles).set(parseCatalogMetadataPatch(input))
        .where(activeBundle(id)).returning();
      if (!row) throw new BundleResourceNotFoundError("Bundle", id);
      return bundleRecord(row);
    },
    async deleteBundle(bundleId: string): Promise<void> {
      const id = catalogId(bundleId);
      await db.transaction(async (transaction) => {
        const [selected] = await transaction.select({ bundleId: bundles.bundleId }).from(bundles)
          .where(activeBundle(id)).for("update");
        if (!selected) throw new BundleResourceNotFoundError("Bundle", id);
        const deletedAt = new Date();
        await transaction.update(bundleMaterials).set({ deletedAt }).where(and(
          eq(bundleMaterials.ownerUserId, owner), eq(bundleMaterials.bundleId, id),
          isNull(bundleMaterials.deletedAt),
        ));
        await transaction.update(bundleSessions).set({ deletedAt }).where(and(
          eq(bundleSessions.ownerUserId, owner), eq(bundleSessions.bundleId, id),
          isNull(bundleSessions.deletedAt),
        ));
        await transaction.update(bundles).set({ deletedAt }).where(activeBundle(id));
      });
    },
    async createMaterial(bundleId: string, input: { name: string; description: string; files: readonly MaterialFile[] }): Promise<MaterialRecord> {
      const id = catalogId(bundleId);
      const name = requiredCatalogLabel(input.name, "name");
      const description = requiredCatalogLabel(input.description, "description");
      await requireBundle(id);
      const reference = { bundleId: id, materialId: crypto.randomUUID() };
      await directory.uploadInitialMaterials(owner, reference, input.files);
      try {
        return await db.transaction(async (transaction) => {
          const [bundle] = await transaction.select({ bundleId: bundles.bundleId }).from(bundles)
            .where(activeBundle(id)).for("update");
          if (!bundle) throw new BundleResourceNotFoundError("Bundle", id);
          const row = { ...reference, ownerUserId: owner, name, description };
          await transaction.insert(bundleMaterials).values(row);
          return materialRecord({ ...row, deletedAt: null });
        });
      } catch (error) {
        await directory.removeInitialMaterials(owner, reference);
        throw error;
      }
    },
    async listMaterials(bundleId: string): Promise<readonly MaterialRecord[]> {
      const id = catalogId(bundleId);
      await requireBundle(id);
      return (await db.select().from(bundleMaterials).where(and(
        eq(bundleMaterials.ownerUserId, owner), eq(bundleMaterials.bundleId, id),
        isNull(bundleMaterials.deletedAt),
      )).orderBy(bundleMaterials.materialId)).map(materialRecord);
    },
    async getMaterial(bundleId: string, materialId: string): Promise<MaterialRecord> {
      const id = catalogId(bundleId);
      const childId = catalogId(materialId);
      await requireBundle(id);
      const [row] = await db.select().from(bundleMaterials).where(and(
        eq(bundleMaterials.ownerUserId, owner), eq(bundleMaterials.bundleId, id),
        eq(bundleMaterials.materialId, childId), isNull(bundleMaterials.deletedAt),
      ));
      if (!row) throw new BundleResourceNotFoundError("Material", childId);
      return materialRecord(row);
    },
    async updateMaterial(bundleId: string, materialId: string, input: CatalogMetadataPatch): Promise<MaterialRecord> {
      const id = catalogId(bundleId);
      const childId = catalogId(materialId);
      const patch = parseCatalogMetadataPatch(input);
      return db.transaction(async (transaction) => {
        const [bundle] = await transaction.select({ bundleId: bundles.bundleId }).from(bundles)
          .where(activeBundle(id)).for("update");
        if (!bundle) throw new BundleResourceNotFoundError("Bundle", id);
        const [row] = await transaction.update(bundleMaterials).set(patch).where(and(
          eq(bundleMaterials.ownerUserId, owner), eq(bundleMaterials.bundleId, id),
          eq(bundleMaterials.materialId, childId), isNull(bundleMaterials.deletedAt),
        )).returning();
        if (!row) throw new BundleResourceNotFoundError("Material", childId);
        return materialRecord(row);
      });
    },
    async deleteMaterial(bundleId: string, materialId: string): Promise<void> {
      const id = catalogId(bundleId);
      const childId = catalogId(materialId);
      await db.transaction(async (transaction) => {
        const [bundle] = await transaction.select({ bundleId: bundles.bundleId }).from(bundles)
          .where(activeBundle(id)).for("update");
        if (!bundle) throw new BundleResourceNotFoundError("Bundle", id);
        const rows = await transaction.update(bundleMaterials).set({ deletedAt: new Date() }).where(and(
          eq(bundleMaterials.ownerUserId, owner), eq(bundleMaterials.bundleId, id),
          eq(bundleMaterials.materialId, childId), isNull(bundleMaterials.deletedAt),
        )).returning({ materialId: bundleMaterials.materialId });
        if (rows.length === 0) throw new BundleResourceNotFoundError("Material", childId);
      });
    },
    async createSession(bundleId: string, input: { name: string; description: string; format: "json" | "jsonl"; content: string }): Promise<SessionRecord> {
      const id = catalogId(bundleId);
      const name = requiredCatalogLabel(input.name, "name");
      const description = requiredCatalogLabel(input.description, "description");
      await requireBundle(id);
      const reference = { bundleId: id, sessionId: crypto.randomUUID() };
      await directory.uploadInitialSession(owner, reference, { format: input.format, content: input.content });
      try {
        return await db.transaction(async (transaction) => {
          const [bundle] = await transaction.select({ bundleId: bundles.bundleId }).from(bundles)
            .where(activeBundle(id)).for("update");
          if (!bundle) throw new BundleResourceNotFoundError("Bundle", id);
          const row = { ...reference, ownerUserId: owner, name, description, format: input.format };
          await transaction.insert(bundleSessions).values(row);
          return sessionRecord({ ...row, deletedAt: null });
        });
      } catch (error) {
        await directory.removeInitialSession(owner, reference);
        throw error;
      }
    },
    async listSessions(bundleId: string): Promise<readonly SessionRecord[]> {
      const id = catalogId(bundleId);
      await requireBundle(id);
      return (await db.select().from(bundleSessions).where(and(
        eq(bundleSessions.ownerUserId, owner), eq(bundleSessions.bundleId, id),
        isNull(bundleSessions.deletedAt),
      )).orderBy(bundleSessions.sessionId)).map(sessionRecord);
    },
    async getSession(bundleId: string, sessionId: string): Promise<SessionRecord> {
      const id = catalogId(bundleId);
      const childId = catalogId(sessionId);
      await requireBundle(id);
      const [row] = await db.select().from(bundleSessions).where(and(
        eq(bundleSessions.ownerUserId, owner), eq(bundleSessions.bundleId, id),
        eq(bundleSessions.sessionId, childId), isNull(bundleSessions.deletedAt),
      ));
      if (!row) throw new BundleResourceNotFoundError("Session", childId);
      return sessionRecord(row);
    },
    async updateSession(bundleId: string, sessionId: string, input: CatalogMetadataPatch): Promise<SessionRecord> {
      const id = catalogId(bundleId);
      const childId = catalogId(sessionId);
      const patch = parseCatalogMetadataPatch(input);
      return db.transaction(async (transaction) => {
        const [bundle] = await transaction.select({ bundleId: bundles.bundleId }).from(bundles)
          .where(activeBundle(id)).for("update");
        if (!bundle) throw new BundleResourceNotFoundError("Bundle", id);
        const [row] = await transaction.update(bundleSessions).set(patch).where(and(
          eq(bundleSessions.ownerUserId, owner), eq(bundleSessions.bundleId, id),
          eq(bundleSessions.sessionId, childId), isNull(bundleSessions.deletedAt),
        )).returning();
        if (!row) throw new BundleResourceNotFoundError("Session", childId);
        return sessionRecord(row);
      });
    },
    async deleteSession(bundleId: string, sessionId: string): Promise<void> {
      const id = catalogId(bundleId);
      const childId = catalogId(sessionId);
      await db.transaction(async (transaction) => {
        const [bundle] = await transaction.select({ bundleId: bundles.bundleId }).from(bundles)
          .where(activeBundle(id)).for("update");
        if (!bundle) throw new BundleResourceNotFoundError("Bundle", id);
        const rows = await transaction.update(bundleSessions).set({ deletedAt: new Date() }).where(and(
          eq(bundleSessions.ownerUserId, owner), eq(bundleSessions.bundleId, id),
          eq(bundleSessions.sessionId, childId), isNull(bundleSessions.deletedAt),
        )).returning({ sessionId: bundleSessions.sessionId });
        if (rows.length === 0) throw new BundleResourceNotFoundError("Session", childId);
      });
    },
  };
}

export async function assertMaterialSelectable(
  reader: Pick<EvalDb, "select">, ownerUserId: string, reference: InitialMaterialsRef,
): Promise<void> {
  const owner = requireOwnerUserId(ownerUserId);
  const bundleId = catalogId(reference.bundleId);
  const materialId = catalogId(reference.materialId);
  const [row] = await reader.select({ materialId: bundleMaterials.materialId }).from(bundleMaterials)
    .innerJoin(bundles, and(eq(bundles.bundleId, bundleMaterials.bundleId),
      eq(bundles.ownerUserId, bundleMaterials.ownerUserId)))
    .where(and(eq(bundleMaterials.ownerUserId, owner), eq(bundleMaterials.bundleId, bundleId),
      eq(bundleMaterials.materialId, materialId), isNull(bundleMaterials.deletedAt),
      isNull(bundles.deletedAt))).for("share");
  if (!row) throw new BundleResourceNotFoundError("Material", materialId);
}

export async function assertSessionSelectable(
  reader: Pick<EvalDb, "select">, ownerUserId: string, reference: InitialSessionRef,
): Promise<void> {
  const owner = requireOwnerUserId(ownerUserId);
  const bundleId = catalogId(reference.bundleId);
  const sessionId = catalogId(reference.sessionId);
  const [row] = await reader.select({ sessionId: bundleSessions.sessionId }).from(bundleSessions)
    .innerJoin(bundles, and(eq(bundles.bundleId, bundleSessions.bundleId),
      eq(bundles.ownerUserId, bundleSessions.ownerUserId)))
    .where(and(eq(bundleSessions.ownerUserId, owner), eq(bundleSessions.bundleId, bundleId),
      eq(bundleSessions.sessionId, sessionId), isNull(bundleSessions.deletedAt),
      isNull(bundles.deletedAt))).for("share");
  if (!row) throw new BundleResourceNotFoundError("Session", sessionId);
}
