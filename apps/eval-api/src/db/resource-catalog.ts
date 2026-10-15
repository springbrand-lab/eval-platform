import type { Data, InitialMaterialsRef, InitialSessionRef } from "@eval-platform/eval-dataset";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { SelectedFieldsFlat } from "drizzle-orm/pg-core";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";
import { createId } from "@springbrand/utils";
import type { MaterialFile, SessionContent } from "../sp/bundle-content.js";
import type { BundleDirectory } from "../sp/bundle-directory.js";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { parseCatalogMetadataPatch, platformId, requiredCatalogLabel, type CatalogMetadataPatch } from "./catalog-metadata.js";
import { BundleResourceInUseError, BundleResourceNotFoundError } from "./errors.js";
import { bundleMaterials, bundleSessions, data, materialBundles, sessionBundles } from "./schema.js";

export interface BundleRecord {
  readonly bundleId: string;
  readonly name: string;
  readonly description: string;
}

export interface CatalogLabels {
  readonly name: string;
  readonly description: string;
}

type MaterialInput = CatalogLabels & { readonly files: readonly MaterialFile[] };
type SessionInput = CatalogLabels & SessionContent;

/** A Bundle together with the resources one batch added to it, in input order. */
export interface BundleImport<R> {
  readonly bundle: BundleRecord;
  readonly imported: readonly R[];
}

/** One owner-scoped Bundle kind holding resources `R` created from inputs `I`. */
export interface BundleCatalog<R, I> {
  list(): Promise<readonly BundleRecord[]>;
  /** Create the Bundle and its resources atomically. */
  create(labels: CatalogLabels, inputs?: readonly I[]): Promise<BundleImport<R>>;
  get(bundleId: string): Promise<BundleRecord>;
  update(bundleId: string, input: CatalogMetadataPatch): Promise<BundleRecord>;
  delete(bundleId: string): Promise<void>;
  /** Append resources to an active Bundle atomically. */
  import(bundleId: string, inputs: readonly I[]): Promise<BundleImport<R>>;
  listResources(bundleId: string): Promise<readonly R[]>;
  createResource(bundleId: string, input: I): Promise<R>;
  getResource(bundleId: string, resourceId: string): Promise<R>;
  updateResource(bundleId: string, resourceId: string, input: CatalogMetadataPatch): Promise<R>;
  deleteResource(bundleId: string, resourceId: string): Promise<void>;
}

type CatalogWriter = Pick<EvalDb, "select" | "insert">;

type DataReferenceField = "initialMaterials" | "evalInitialMaterials" | "initialSession";

/** A new resource's public record plus the BundleDirectory writes that store and undo its bytes. */
interface PreparedResource<R> {
  readonly record: R;
  readonly upload: () => Promise<void>;
  readonly remove: () => Promise<void>;
}

/** A Bundle kind: its own table, the single soft-deletable resource kind it holds, and the Data fields referencing it. */
interface BundleKind<F extends SelectedFieldsFlat, I> {
  readonly kind: "Material Bundle" | "Session Bundle";
  readonly table: typeof materialBundles | typeof sessionBundles;
  readonly dataFields: readonly DataReferenceField[];
  readonly resource: {
    readonly kind: "Material" | "Session";
    readonly idField: "materialId" | "sessionId";
    readonly table: typeof bundleMaterials | typeof bundleSessions;
    readonly id: typeof bundleMaterials.materialId | typeof bundleSessions.sessionId;
    /** The public record columns. */
    readonly fields: F;
    readonly prepare: (directory: BundleDirectory, owner: string, bundleId: string, input: I) =>
      PreparedResource<SelectResultFields<F>>;
  };
}

function labels(input: CatalogLabels): CatalogLabels {
  return { name: requiredCatalogLabel(input.name, "name"), description: requiredCatalogLabel(input.description, "description") };
}

const materialBundle = {
  kind: "Material Bundle",
  table: materialBundles,
  dataFields: ["initialMaterials", "evalInitialMaterials"],
  resource: {
    kind: "Material",
    idField: "materialId",
    table: bundleMaterials,
    id: bundleMaterials.materialId,
    fields: { bundleId: bundleMaterials.bundleId, materialId: bundleMaterials.materialId,
      name: bundleMaterials.name, description: bundleMaterials.description },
    prepare: (directory: BundleDirectory, owner: string, bundleId: string, input: MaterialInput) => {
      const reference = { bundleId, materialId: createId() };
      return {
        record: { ...reference, ...labels(input) },
        upload: () => directory.uploadInitialMaterials(owner, reference, input.files),
        remove: () => directory.removeInitialMaterials(owner, reference),
      };
    },
  },
} as const satisfies BundleKind<SelectedFieldsFlat, MaterialInput>;

const sessionBundle = {
  kind: "Session Bundle",
  table: sessionBundles,
  dataFields: ["initialSession"],
  resource: {
    kind: "Session",
    idField: "sessionId",
    table: bundleSessions,
    id: bundleSessions.sessionId,
    fields: { bundleId: bundleSessions.bundleId, sessionId: bundleSessions.sessionId,
      name: bundleSessions.name, description: bundleSessions.description, format: bundleSessions.format },
    prepare: (directory: BundleDirectory, owner: string, bundleId: string, input: SessionInput) => {
      const reference = { bundleId, sessionId: createId() };
      return {
        record: { ...reference, ...labels(input), format: input.format },
        upload: () => directory.uploadInitialSession(owner, reference, { format: input.format, content: input.content }),
        remove: () => directory.removeInitialSession(owner, reference),
      };
    },
  },
} as const satisfies BundleKind<SelectedFieldsFlat, SessionInput>;

export type MaterialRecord = SelectResultFields<typeof materialBundle.resource.fields>;
export type SessionRecord = SelectResultFields<typeof sessionBundle.resource.fields>;

function referenceCondition(field: DataReferenceField, key: string, id: string) {
  return sql`${data.content} -> ${field} ->> ${key} = ${id}`;
}

async function activeDataBinding(
  reader: Pick<EvalDb, "select">, owner: string, condition: SQL | undefined,
): Promise<boolean> {
  const [bound] = await reader.select({ dataId: data.dataId }).from(data).where(and(
    eq(data.ownerUserId, owner), isNull(data.deletedAt), condition,
  )).limit(1);
  return bound !== undefined;
}

function bundleRecord(row: typeof materialBundles.$inferSelect): BundleRecord {
  return { bundleId: row.bundleId, name: row.name, description: row.description };
}

function activeResource(bundle: BundleKind<SelectedFieldsFlat, never>, owner: string, bundleId: string, resourceId?: string) {
  const { table, id } = bundle.resource;
  return and(eq(table.ownerUserId, owner), eq(table.bundleId, bundleId), isNull(table.deletedAt),
    resourceId === undefined ? undefined : eq(id, resourceId));
}

/** One owner-scoped Bundle kind. Bytes remain in BundleDirectory, untouched by soft deletes. */
function createBundleCatalog<F extends SelectedFieldsFlat, I>(
  db: EvalDb, owner: string, directory: BundleDirectory, bundle: BundleKind<F, I>,
): BundleCatalog<SelectResultFields<F>, I> {
  const { table, resource } = bundle;
  type ResourceRecord = SelectResultFields<F>;
  const activeBundle = (bundleId: string) => and(
    eq(table.ownerUserId, owner), eq(table.bundleId, bundleId), isNull(table.deletedAt),
  );
  const resourceRow = (bundleId: string, resourceId?: string) => activeResource(bundle, owner, bundleId, resourceId);
  const dataBinding = (bundleId: string, resourceId?: string) => or(...bundle.dataFields.map((field) => and(
    referenceCondition(field, "bundleId", bundleId),
    resourceId === undefined ? undefined : referenceCondition(field, resource.idField, resourceId),
  )));
  async function requireBundle(bundleId: string): Promise<BundleRecord> {
    const id = platformId(bundleId, "bundleId");
    const [row] = await db.select().from(table).where(activeBundle(id));
    if (!row) throw new BundleResourceNotFoundError(bundle.kind, id);
    return bundleRecord(row);
  }
  async function lockBundle(transaction: Pick<EvalDb, "select">, bundleId: string): Promise<BundleRecord> {
    const [row] = await transaction.select().from(table).where(activeBundle(bundleId)).for("update");
    if (!row) throw new BundleResourceNotFoundError(bundle.kind, bundleId);
    return bundleRecord(row);
  }
  /**
   * The single resource write path: store every resource's bytes, then commit the Bundle claim and all
   * resource rows in one transaction. A failure removes every file this batch wrote.
   */
  async function importResources(
    bundleId: string, claim: (transaction: CatalogWriter) => Promise<BundleRecord>, inputs: readonly I[],
  ): Promise<BundleImport<ResourceRecord>> {
    const prepared = inputs.map((input) => resource.prepare(directory, owner, bundleId, input));
    const written: PreparedResource<ResourceRecord>[] = [];
    try {
      for (const item of prepared) {
        written.push(item);
        await item.upload();
      }
      return await db.transaction(async (transaction) => {
        const claimed = await claim(transaction);
        const imported = prepared.map(({ record }) => record);
        // Drizzle cannot type an insert into a generic table; `prepare` builds each record from the same columns.
        if (imported.length > 0) {
          await transaction.insert(resource.table).values(imported.map((record) => ({ ...record, ownerUserId: owner })) as never);
        }
        return { bundle: claimed, imported };
      });
    } catch (error) {
      const removals = await Promise.allSettled(written.map((item) => item.remove()));
      const failures = removals.flatMap((removal) => removal.status === "rejected" ? [removal.reason] : []);
      if (failures.length > 0) {
        throw new AggregateError([error, ...failures], `${bundle.kind} import failed and its files could not all be removed`);
      }
      throw error;
    }
  }
  async function importInto(bundleId: string, inputs: readonly I[]): Promise<BundleImport<ResourceRecord>> {
    const id = platformId(bundleId, "bundleId");
    await requireBundle(id);
    return importResources(id, (transaction) => lockBundle(transaction, id), inputs);
  }
  return {
    async list(): Promise<readonly BundleRecord[]> {
      return (await db.select().from(table).where(and(
        eq(table.ownerUserId, owner), isNull(table.deletedAt),
      )).orderBy(table.bundleId)).map(bundleRecord);
    },
    async create(input: CatalogLabels, inputs: readonly I[] = []): Promise<BundleImport<ResourceRecord>> {
      const created: BundleRecord = { bundleId: createId(), ...labels(input) };
      return importResources(created.bundleId, async (transaction) => {
        await transaction.insert(table).values({ ...created, ownerUserId: owner });
        return created;
      }, inputs);
    },
    get: requireBundle,
    async update(bundleId: string, input: CatalogMetadataPatch): Promise<BundleRecord> {
      const id = platformId(bundleId, "bundleId");
      const [row] = await db.update(table).set(parseCatalogMetadataPatch(input))
        .where(activeBundle(id)).returning();
      if (!row) throw new BundleResourceNotFoundError(bundle.kind, id);
      return bundleRecord(row);
    },
    async delete(bundleId: string): Promise<void> {
      const id = platformId(bundleId, "bundleId");
      await db.transaction(async (transaction) => {
        await lockBundle(transaction, id);
        if (await activeDataBinding(transaction, owner, dataBinding(id))) {
          throw new BundleResourceInUseError(bundle.kind, id);
        }
        const deletedAt = new Date();
        await transaction.update(resource.table).set({ deletedAt }).where(resourceRow(id));
        await transaction.update(table).set({ deletedAt }).where(activeBundle(id));
      });
    },
    import: importInto,
    async listResources(bundleId: string): Promise<readonly ResourceRecord[]> {
      const id = platformId(bundleId, "bundleId");
      await requireBundle(id);
      // Drizzle leaves rows of a generic selection unresolved; `resource.fields` fixes their shape.
      return await db.select(resource.fields).from(resource.table)
        .where(resourceRow(id)).orderBy(resource.id) as ResourceRecord[];
    },
    async createResource(bundleId: string, input: I): Promise<ResourceRecord> {
      return (await importInto(bundleId, [input])).imported[0]!;
    },
    async getResource(bundleId: string, resourceId: string): Promise<ResourceRecord> {
      const id = platformId(bundleId, "bundleId");
      const childId = platformId(resourceId, resource.idField);
      await requireBundle(id);
      const [row] = await db.select(resource.fields).from(resource.table).where(resourceRow(id, childId));
      if (!row) throw new BundleResourceNotFoundError(resource.kind, childId);
      return row;
    },
    async updateResource(bundleId: string, resourceId: string, input: CatalogMetadataPatch): Promise<ResourceRecord> {
      const id = platformId(bundleId, "bundleId");
      const childId = platformId(resourceId, resource.idField);
      const patch = parseCatalogMetadataPatch(input);
      return db.transaction(async (transaction) => {
        await lockBundle(transaction, id);
        const [row] = await transaction.update(resource.table).set(patch)
          .where(resourceRow(id, childId)).returning(resource.fields) as ResourceRecord[];
        if (!row) throw new BundleResourceNotFoundError(resource.kind, childId);
        return row;
      });
    },
    async deleteResource(bundleId: string, resourceId: string): Promise<void> {
      const id = platformId(bundleId, "bundleId");
      const childId = platformId(resourceId, resource.idField);
      await db.transaction(async (transaction) => {
        await lockBundle(transaction, id);
        const [selected] = await transaction.select({ id: resource.id }).from(resource.table)
          .where(resourceRow(id, childId)).for("update");
        if (!selected) throw new BundleResourceNotFoundError(resource.kind, childId);
        if (await activeDataBinding(transaction, owner, dataBinding(id, childId))) {
          throw new BundleResourceInUseError(resource.kind, childId);
        }
        await transaction.update(resource.table).set({ deletedAt: new Date() }).where(resourceRow(id, childId));
      });
    },
  };
}

/** The owner's Material Bundle and Session Bundle catalogs. */
export function createBundleCatalogs(db: EvalDb, ownerUserId: string, directory: BundleDirectory) {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    materialBundles: createBundleCatalog(db, owner, directory, materialBundle),
    sessionBundles: createBundleCatalog(db, owner, directory, sessionBundle),
  };
}

export type BundleCatalogs = ReturnType<typeof createBundleCatalogs>;

async function assertResourceSelectable(
  bundle: BundleKind<SelectedFieldsFlat, never>, reader: Pick<EvalDb, "select">, ownerUserId: string,
  bundleId: string, resourceId: string,
): Promise<void> {
  const owner = requireOwnerUserId(ownerUserId);
  const { table, resource } = bundle;
  const id = platformId(resourceId, resource.idField);
  const [row] = await reader.select({ id: resource.id }).from(resource.table)
    .innerJoin(table, and(eq(table.bundleId, resource.table.bundleId),
      eq(table.ownerUserId, resource.table.ownerUserId)))
    .where(and(activeResource(bundle, owner, platformId(bundleId, "bundleId"), id), isNull(table.deletedAt)))
    .for("share");
  if (!row) throw new BundleResourceNotFoundError(resource.kind, id);
}

export function assertMaterialSelectable(
  reader: Pick<EvalDb, "select">, ownerUserId: string, reference: InitialMaterialsRef,
): Promise<void> {
  return assertResourceSelectable(materialBundle, reader, ownerUserId, reference.bundleId, reference.materialId);
}

export function assertSessionSelectable(
  reader: Pick<EvalDb, "select">, ownerUserId: string, reference: InitialSessionRef,
): Promise<void> {
  return assertResourceSelectable(sessionBundle, reader, ownerUserId, reference.bundleId, reference.sessionId);
}

/** Validate every resource reference before a Data row is created or replaced. */
export async function assertDataReferencesSelectable(
  reader: Pick<EvalDb, "select">, ownerUserId: string, record: Data,
): Promise<void> {
  if (record.initialMaterials) await assertMaterialSelectable(reader, ownerUserId, record.initialMaterials);
  if (record.evalInitialMaterials) await assertMaterialSelectable(reader, ownerUserId, record.evalInitialMaterials);
  if (record.initialSession) await assertSessionSelectable(reader, ownerUserId, record.initialSession);
}
