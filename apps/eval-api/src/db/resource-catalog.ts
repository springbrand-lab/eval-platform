import type { Data, InitialMaterialsRef, InitialSessionRef } from "@eval-platform/eval-dataset";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { SelectedFieldsFlat } from "drizzle-orm/pg-core";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";
import type { BundleDirectory, MaterialFile } from "../sp/bundle-directory.js";
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

type ChildTable = typeof bundleMaterials | typeof bundleSessions;

/** Materials and Sessions are soft-deletable Bundle children that share every metadata rule. */
interface ChildResource<F extends SelectedFieldsFlat> {
  readonly kind: "Material" | "Session";
  readonly idField: "materialId" | "sessionId";
  readonly table: ChildTable;
  readonly id: typeof bundleMaterials.materialId | typeof bundleSessions.sessionId;
  /** The public record columns. */
  readonly fields: F;
  /** Matches active Data rows that reference this resource. */
  readonly dataBinding: (bundleId: string, resourceId: string) => SQL | undefined;
}

const materialResource = {
  kind: "Material",
  idField: "materialId",
  table: bundleMaterials,
  id: bundleMaterials.materialId,
  fields: { bundleId: bundleMaterials.bundleId, materialId: bundleMaterials.materialId,
    name: bundleMaterials.name, description: bundleMaterials.description },
  dataBinding: (bundleId: string, materialId: string) => or(
    materialCondition("initialMaterials", bundleId, materialId),
    materialCondition("evalInitialMaterials", bundleId, materialId),
  ),
} as const satisfies ChildResource<SelectedFieldsFlat>;

const sessionResource = {
  kind: "Session",
  idField: "sessionId",
  table: bundleSessions,
  id: bundleSessions.sessionId,
  fields: { bundleId: bundleSessions.bundleId, sessionId: bundleSessions.sessionId,
    name: bundleSessions.name, description: bundleSessions.description, format: bundleSessions.format },
  dataBinding: (bundleId: string, sessionId: string) => and(
    resourceBundleCondition("initialSession", bundleId),
    sql`${data.content} -> 'initialSession' ->> 'sessionId' = ${sessionId}`,
  ),
} as const satisfies ChildResource<SelectedFieldsFlat>;

export type MaterialRecord = SelectResultFields<typeof materialResource.fields>;
export type SessionRecord = SelectResultFields<typeof sessionResource.fields>;

function activeChildren(table: ChildTable, owner: string, bundleId: string) {
  return and(eq(table.ownerUserId, owner), eq(table.bundleId, bundleId), isNull(table.deletedAt));
}

function activeChild(
  resource: ChildResource<SelectedFieldsFlat>, owner: string, bundleId: string, resourceId: string,
) {
  return and(activeChildren(resource.table, owner, bundleId), eq(resource.id, resourceId));
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
  async function lockBundle(transaction: Pick<EvalDb, "select">, bundleId: string): Promise<void> {
    const [bundle] = await transaction.select({ bundleId: bundles.bundleId }).from(bundles)
      .where(activeBundle(bundleId)).for("update");
    if (!bundle) throw new BundleResourceNotFoundError("Bundle", bundleId);
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
        await lockBundle(transaction, bundleId);
        return insert(transaction);
      });
    } catch (error) {
      await remove();
      throw error;
    }
  }
  function childResourceCatalog<F extends SelectedFieldsFlat>(resource: ChildResource<F>) {
    return {
      async list(bundleId: string): Promise<readonly SelectResultFields<F>[]> {
        const id = platformId(bundleId, "bundleId");
        await requireBundle(id);
        // Drizzle leaves rows of a generic selection unresolved; `resource.fields` fixes their shape.
        return await db.select(resource.fields).from(resource.table)
          .where(activeChildren(resource.table, owner, id)).orderBy(resource.id) as SelectResultFields<F>[];
      },
      async get(bundleId: string, resourceId: string): Promise<SelectResultFields<F>> {
        const id = platformId(bundleId, "bundleId");
        const childId = platformId(resourceId, resource.idField);
        await requireBundle(id);
        const [row] = await db.select(resource.fields).from(resource.table)
          .where(activeChild(resource, owner, id, childId));
        if (!row) throw new BundleResourceNotFoundError(resource.kind, childId);
        return row;
      },
      async update(bundleId: string, resourceId: string, input: CatalogMetadataPatch): Promise<SelectResultFields<F>> {
        const id = platformId(bundleId, "bundleId");
        const childId = platformId(resourceId, resource.idField);
        const patch = parseCatalogMetadataPatch(input);
        return db.transaction(async (transaction) => {
          await lockBundle(transaction, id);
          const [row] = await transaction.update(resource.table).set(patch)
            .where(activeChild(resource, owner, id, childId)).returning(resource.fields) as SelectResultFields<F>[];
          if (!row) throw new BundleResourceNotFoundError(resource.kind, childId);
          return row;
        });
      },
      async delete(bundleId: string, resourceId: string): Promise<void> {
        const id = platformId(bundleId, "bundleId");
        const childId = platformId(resourceId, resource.idField);
        await db.transaction(async (transaction) => {
          await lockBundle(transaction, id);
          const [selected] = await transaction.select({ id: resource.id }).from(resource.table)
            .where(activeChild(resource, owner, id, childId)).for("update");
          if (!selected) throw new BundleResourceNotFoundError(resource.kind, childId);
          if (await activeDataBinding(transaction, owner, resource.dataBinding(id, childId))) {
            throw new BundleResourceInUseError(resource.kind, childId);
          }
          await transaction.update(resource.table).set({ deletedAt: new Date() })
            .where(activeChild(resource, owner, id, childId));
        });
      },
    };
  }
  const materials = childResourceCatalog(materialResource);
  const sessions = childResourceCatalog(sessionResource);
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
        await lockBundle(transaction, id);
        if (await activeDataBinding(transaction, owner, or(
          resourceBundleCondition("initialMaterials", id),
          resourceBundleCondition("evalInitialMaterials", id),
          resourceBundleCondition("initialSession", id),
        ))) throw new BundleResourceInUseError("Bundle", id);
        const deletedAt = new Date();
        for (const table of [bundleMaterials, bundleSessions]) {
          await transaction.update(table).set({ deletedAt }).where(activeChildren(table, owner, id));
        }
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
          const record = { ...reference, name, description };
          await writer.insert(bundleMaterials).values({ ...record, ownerUserId: owner });
          return record;
        },
        () => directory.removeInitialMaterials(owner, reference),
      );
    },
    listMaterials: materials.list,
    getMaterial: materials.get,
    updateMaterial: materials.update,
    deleteMaterial: materials.delete,
    async createSession(bundleId: string, input: { name: string; description: string; format: "json" | "jsonl"; content: string }): Promise<SessionRecord> {
      const id = platformId(bundleId, "bundleId");
      const name = requiredCatalogLabel(input.name, "name");
      const description = requiredCatalogLabel(input.description, "description");
      const reference = { bundleId: id, sessionId: crypto.randomUUID() };
      return uploadOneResource(id,
        () => directory.uploadInitialSession(owner, reference, { format: input.format, content: input.content }),
        async (writer) => {
          const record = { ...reference, name, description, format: input.format };
          await writer.insert(bundleSessions).values({ ...record, ownerUserId: owner });
          return record;
        },
        () => directory.removeInitialSession(owner, reference),
      );
    },
    listSessions: sessions.list,
    getSession: sessions.get,
    updateSession: sessions.update,
    deleteSession: sessions.delete,
  };
}

async function assertChildSelectable(
  resource: ChildResource<SelectedFieldsFlat>, reader: Pick<EvalDb, "select">, ownerUserId: string,
  bundleId: string, resourceId: string,
): Promise<void> {
  const owner = requireOwnerUserId(ownerUserId);
  const id = platformId(resourceId, resource.idField);
  const [row] = await reader.select({ id: resource.id }).from(resource.table)
    .innerJoin(bundles, and(eq(bundles.bundleId, resource.table.bundleId),
      eq(bundles.ownerUserId, resource.table.ownerUserId)))
    .where(and(activeChild(resource, owner, platformId(bundleId, "bundleId"), id), isNull(bundles.deletedAt)))
    .for("share");
  if (!row) throw new BundleResourceNotFoundError(resource.kind, id);
}

export function assertMaterialSelectable(
  reader: Pick<EvalDb, "select">, ownerUserId: string, reference: InitialMaterialsRef,
): Promise<void> {
  return assertChildSelectable(materialResource, reader, ownerUserId, reference.bundleId, reference.materialId);
}

export function assertSessionSelectable(
  reader: Pick<EvalDb, "select">, ownerUserId: string, reference: InitialSessionRef,
): Promise<void> {
  return assertChildSelectable(sessionResource, reader, ownerUserId, reference.bundleId, reference.sessionId);
}

/** Validate every resource reference before a Data row is created or replaced. */
export async function assertDataReferencesSelectable(
  reader: Pick<EvalDb, "select">, ownerUserId: string, record: Data,
): Promise<void> {
  if (record.initialMaterials) await assertMaterialSelectable(reader, ownerUserId, record.initialMaterials);
  if (record.evalInitialMaterials) await assertMaterialSelectable(reader, ownerUserId, record.evalInitialMaterials);
  if (record.initialSession) await assertSessionSelectable(reader, ownerUserId, record.initialSession);
}
