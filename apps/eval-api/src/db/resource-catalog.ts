import type { Data, InitialMaterialsRef, InitialSessionRef } from "@eval-platform/eval-dataset";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { BundleDirectory, MaterialFile, SessionContent } from "../sp/bundle-directory.js";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { parseCatalogMetadataPatch, platformId, requiredCatalogLabel, type CatalogMetadataPatch } from "./catalog-metadata.js";
import { BundleResourceInUseError, BundleResourceNotFoundError } from "./errors.js";
import { bundleMaterials, bundleSessions, bundles, data } from "./schema.js";

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

function resourceBundleCondition(field: "initialMaterials" | "evalInitialMaterials" | "initialSession", bundleId: string) {
  return sql`${data.content} -> ${field} ->> 'bundleId' = ${bundleId}`;
}

function materialCondition(field: "initialMaterials" | "evalInitialMaterials", bundleId: string, materialId: string) {
  return and(resourceBundleCondition(field, bundleId),
    sql`${data.content} -> ${field} ->> 'materialId' = ${materialId}`);
}

async function activeDataBinding(
  reader: Pick<EvalDb, "select">, owner: string, condition: SQL | undefined,
): Promise<boolean> {
  const [bound] = await reader.select({ dataId: data.dataId }).from(data).where(and(
    eq(data.ownerUserId, owner), isNull(data.deletedAt), condition,
  )).limit(1);
  return bound !== undefined;
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
    eq(bundles.ownerUserId, owner), eq(bundles.bundleId, platformId(bundleId, "bundleId")), isNull(bundles.deletedAt),
  );
  async function requireBundle(bundleId: string): Promise<BundleRecord> {
    const [row] = await db.select().from(bundles).where(activeBundle(bundleId));
    if (!row) throw new BundleResourceNotFoundError("Bundle", bundleId);
    return bundleRecord(row);
  }
  async function uploadOneResource<T>(
    bundleId: string,
    upload: () => Promise<void>,
    insert: (writer: Pick<EvalDb, "insert">) => Promise<T>,
    remove: () => Promise<void>,
  ): Promise<T> {
    await requireBundle(bundleId);
    await upload();
    try {
      return await db.transaction(async (transaction) => {
        const [bundle] = await transaction.select({ bundleId: bundles.bundleId }).from(bundles)
          .where(activeBundle(bundleId)).for("update");
        if (!bundle) throw new BundleResourceNotFoundError("Bundle", bundleId);
        return insert(transaction);
      });
    } catch (error) {
      await remove();
      throw error;
    }
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
      const id = platformId(bundleId, "bundleId");
      const [row] = await db.update(bundles).set(parseCatalogMetadataPatch(input))
        .where(activeBundle(id)).returning();
      if (!row) throw new BundleResourceNotFoundError("Bundle", id);
      return bundleRecord(row);
    },
    async deleteBundle(bundleId: string): Promise<void> {
      const id = platformId(bundleId, "bundleId");
      await db.transaction(async (transaction) => {
        const [selected] = await transaction.select({ bundleId: bundles.bundleId }).from(bundles)
          .where(activeBundle(id)).for("update");
        if (!selected) throw new BundleResourceNotFoundError("Bundle", id);
        if (await activeDataBinding(transaction, owner, or(
          resourceBundleCondition("initialMaterials", id),
          resourceBundleCondition("evalInitialMaterials", id),
          resourceBundleCondition("initialSession", id),
        ))) throw new BundleResourceInUseError("Bundle", id);
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
      const id = platformId(bundleId, "bundleId");
      const name = requiredCatalogLabel(input.name, "name");
      const description = requiredCatalogLabel(input.description, "description");
      const reference = { bundleId: id, materialId: crypto.randomUUID() };
      return uploadOneResource(id,
        () => directory.uploadInitialMaterials(owner, reference, input.files),
        async (writer) => {
          const row = { ...reference, ownerUserId: owner, name, description };
          await writer.insert(bundleMaterials).values(row);
          return materialRecord({ ...row, deletedAt: null });
        },
        () => directory.removeInitialMaterials(owner, reference),
      );
    },
    async listMaterials(bundleId: string): Promise<readonly MaterialRecord[]> {
      const id = platformId(bundleId, "bundleId");
      await requireBundle(id);
      return (await db.select().from(bundleMaterials).where(and(
        eq(bundleMaterials.ownerUserId, owner), eq(bundleMaterials.bundleId, id),
        isNull(bundleMaterials.deletedAt),
      )).orderBy(bundleMaterials.materialId)).map(materialRecord);
    },
    async getMaterial(bundleId: string, materialId: string): Promise<MaterialRecord> {
      const id = platformId(bundleId, "bundleId");
      const childId = platformId(materialId, "materialId");
      await requireBundle(id);
      const [row] = await db.select().from(bundleMaterials).where(and(
        eq(bundleMaterials.ownerUserId, owner), eq(bundleMaterials.bundleId, id),
        eq(bundleMaterials.materialId, childId), isNull(bundleMaterials.deletedAt),
      ));
      if (!row) throw new BundleResourceNotFoundError("Material", childId);
      return materialRecord(row);
    },
    async updateMaterial(bundleId: string, materialId: string, input: CatalogMetadataPatch): Promise<MaterialRecord> {
      const id = platformId(bundleId, "bundleId");
      const childId = platformId(materialId, "materialId");
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
      const id = platformId(bundleId, "bundleId");
      const childId = platformId(materialId, "materialId");
      await db.transaction(async (transaction) => {
        const [bundle] = await transaction.select({ bundleId: bundles.bundleId }).from(bundles)
          .where(activeBundle(id)).for("update");
        if (!bundle) throw new BundleResourceNotFoundError("Bundle", id);
        const [selected] = await transaction.select({ materialId: bundleMaterials.materialId })
          .from(bundleMaterials).where(and(
            eq(bundleMaterials.ownerUserId, owner), eq(bundleMaterials.bundleId, id),
            eq(bundleMaterials.materialId, childId), isNull(bundleMaterials.deletedAt),
          )).for("update");
        if (!selected) throw new BundleResourceNotFoundError("Material", childId);
        if (await activeDataBinding(transaction, owner, or(
          materialCondition("initialMaterials", id, childId),
          materialCondition("evalInitialMaterials", id, childId),
        ))) throw new BundleResourceInUseError("Material", childId);
        await transaction.update(bundleMaterials).set({ deletedAt: new Date() }).where(and(
          eq(bundleMaterials.ownerUserId, owner), eq(bundleMaterials.bundleId, id),
          eq(bundleMaterials.materialId, childId), isNull(bundleMaterials.deletedAt),
        ));
      });
    },
    async createSession(bundleId: string, input: { name: string; description: string; format: "json" | "jsonl"; content: string }): Promise<SessionRecord> {
      const id = platformId(bundleId, "bundleId");
      const name = requiredCatalogLabel(input.name, "name");
      const description = requiredCatalogLabel(input.description, "description");
      const reference = { bundleId: id, sessionId: crypto.randomUUID() };
      return uploadOneResource(id,
        () => directory.uploadInitialSession(owner, reference, { format: input.format, content: input.content }),
        async (writer) => {
          const row = { ...reference, ownerUserId: owner, name, description, format: input.format };
          await writer.insert(bundleSessions).values(row);
          return sessionRecord({ ...row, deletedAt: null });
        },
        () => directory.removeInitialSession(owner, reference),
      );
    },
    async listSessions(bundleId: string): Promise<readonly SessionRecord[]> {
      const id = platformId(bundleId, "bundleId");
      await requireBundle(id);
      return (await db.select().from(bundleSessions).where(and(
        eq(bundleSessions.ownerUserId, owner), eq(bundleSessions.bundleId, id),
        isNull(bundleSessions.deletedAt),
      )).orderBy(bundleSessions.sessionId)).map(sessionRecord);
    },
    async getSession(bundleId: string, sessionId: string): Promise<SessionRecord> {
      const id = platformId(bundleId, "bundleId");
      const childId = platformId(sessionId, "sessionId");
      await requireBundle(id);
      const [row] = await db.select().from(bundleSessions).where(and(
        eq(bundleSessions.ownerUserId, owner), eq(bundleSessions.bundleId, id),
        eq(bundleSessions.sessionId, childId), isNull(bundleSessions.deletedAt),
      ));
      if (!row) throw new BundleResourceNotFoundError("Session", childId);
      return sessionRecord(row);
    },
    async updateSession(bundleId: string, sessionId: string, input: CatalogMetadataPatch): Promise<SessionRecord> {
      const id = platformId(bundleId, "bundleId");
      const childId = platformId(sessionId, "sessionId");
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
      const id = platformId(bundleId, "bundleId");
      const childId = platformId(sessionId, "sessionId");
      await db.transaction(async (transaction) => {
        const [bundle] = await transaction.select({ bundleId: bundles.bundleId }).from(bundles)
          .where(activeBundle(id)).for("update");
        if (!bundle) throw new BundleResourceNotFoundError("Bundle", id);
        const [selected] = await transaction.select({ sessionId: bundleSessions.sessionId })
          .from(bundleSessions).where(and(
            eq(bundleSessions.ownerUserId, owner), eq(bundleSessions.bundleId, id),
            eq(bundleSessions.sessionId, childId), isNull(bundleSessions.deletedAt),
          )).for("update");
        if (!selected) throw new BundleResourceNotFoundError("Session", childId);
        if (await activeDataBinding(transaction, owner, and(
          resourceBundleCondition("initialSession", id),
          sql`${data.content} -> 'initialSession' ->> 'sessionId' = ${childId}`,
        ))) {
          throw new BundleResourceInUseError("Session", childId);
        }
        await transaction.update(bundleSessions).set({ deletedAt: new Date() }).where(and(
          eq(bundleSessions.ownerUserId, owner), eq(bundleSessions.bundleId, id),
          eq(bundleSessions.sessionId, childId), isNull(bundleSessions.deletedAt),
        ));
      });
    },
  };
}

export async function assertMaterialSelectable(
  reader: Pick<EvalDb, "select">, ownerUserId: string, reference: InitialMaterialsRef,
): Promise<void> {
  const owner = requireOwnerUserId(ownerUserId);
  const bundleId = platformId(reference.bundleId, "bundleId");
  const materialId = platformId(reference.materialId, "materialId");
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
  const bundleId = platformId(reference.bundleId, "bundleId");
  const sessionId = platformId(reference.sessionId, "sessionId");
  const [row] = await reader.select({ sessionId: bundleSessions.sessionId }).from(bundleSessions)
    .innerJoin(bundles, and(eq(bundles.bundleId, bundleSessions.bundleId),
      eq(bundles.ownerUserId, bundleSessions.ownerUserId)))
    .where(and(eq(bundleSessions.ownerUserId, owner), eq(bundleSessions.bundleId, bundleId),
      eq(bundleSessions.sessionId, sessionId), isNull(bundleSessions.deletedAt),
      isNull(bundles.deletedAt))).for("share");
  if (!row) throw new BundleResourceNotFoundError("Session", sessionId);
}

/** Validate every resource reference before a Data row is created or replaced. */
export async function assertDataReferencesSelectable(
  reader: Pick<EvalDb, "select">, ownerUserId: string, record: Data,
): Promise<void> {
  if (record.initialMaterials) await assertMaterialSelectable(reader, ownerUserId, record.initialMaterials);
  if (record.evalInitialMaterials) await assertMaterialSelectable(reader, ownerUserId, record.evalInitialMaterials);
  if (record.initialSession) await assertSessionSelectable(reader, ownerUserId, record.initialSession);
}
