import { isDeepStrictEqual } from "node:util";
import type { Data, InitialMaterialsRef, InitialSessionRef } from "@eval-platform/eval-dataset";
import { and, eq, isNull } from "drizzle-orm";
import type { SelectedFieldsFlat } from "drizzle-orm/pg-core";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";
import { createId, type InitialResourceFile } from "@eval-platform/eval-contracts";
import { requireInitializationBudget, type MaterialFile, type SessionContent } from "../sp/bundle-content.js";
import type { BundleDirectory } from "../sp/bundle-directory.js";
import { BundleFileError } from "../sp/bundle-errors.js";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { parseCatalogMetadataPatch, platformId, requiredCatalogLabel, type CatalogMetadataPatch } from "./catalog-metadata.js";
import { BundleResourceNotFoundError, CatalogInputError } from "./errors.js";
import { bundleMaterials, bundleSessions, materialBundles, sessionBundles } from "./schema.js";

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

/** Planned before an idempotent management preparation write; ordinary HTTP creates generate their own IDs. */
export interface PlannedBundleIdentity {
  readonly bundleId: string;
  readonly resourceIds: readonly string[];
}

/** One owner-scoped Bundle kind holding resources `R` created from inputs `I`. */
export interface BundleCatalog<R, I> {
  list(): Promise<readonly BundleRecord[]>;
  /** Create the Bundle and its resources atomically. */
  create(labels: CatalogLabels, inputs?: readonly I[], planned?: PlannedBundleIdentity): Promise<BundleImport<R>>;
  get(bundleId: string): Promise<BundleRecord>;
  update(bundleId: string, input: CatalogMetadataPatch): Promise<BundleRecord>;
  delete(bundleId: string): Promise<void>;
  /** Append resources to an active Bundle atomically. */
  import(bundleId: string, inputs: readonly I[]): Promise<BundleImport<R>>;
  listResources(bundleId: string): Promise<readonly R[]>;
  createResource(bundleId: string, input: I): Promise<R>;
  getResource(bundleId: string, resourceId: string): Promise<R>;
  /** Inventory of the active resource's immutable stored files, without their content. */
  listFiles(bundleId: string, resourceId: string): Promise<readonly InitialResourceFile[]>;
  /** Read an exact inventory path, never a filesystem-relative path. */
  getFile(bundleId: string, resourceId: string, path: string): Promise<InitialResourceFileContent>;
  updateResource(bundleId: string, resourceId: string, input: CatalogMetadataPatch): Promise<R>;
  deleteResource(bundleId: string, resourceId: string): Promise<void>;
}

export interface InitialResourceFileContent extends InitialResourceFile {
  readonly bytes: Uint8Array;
}

interface StoredResourceFile extends InitialResourceFile {
  readonly readBytes: () => Uint8Array;
}

type CatalogWriter = Pick<EvalDb, "select" | "insert">;
type DataReferences = { readonly [K in "initialMaterials" | "evalInitialMaterials" | "initialSession"]?: Data[K] | null };

/** A Data field holding references to one Bundle kind's resources: a list, or a single reference. */
interface DataReferenceField {
  readonly field: "initialMaterials" | "evalInitialMaterials" | "initialSession";
  readonly list: boolean;
}

/** The BundleDirectory writes that store a new resource's bytes, yielding its record, and undo them. */
interface PreparedResource<R> {
  readonly upload: () => Promise<R>;
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
    readonly prepare: (directory: BundleDirectory, owner: string, bundleId: string, input: I, plannedId?: string) =>
      PreparedResource<SelectResultFields<F>>;
    readonly readFiles: (directory: BundleDirectory, owner: string, bundleId: string, resourceId: string) =>
      Promise<readonly StoredResourceFile[]>;
  };
}

function labels(input: CatalogLabels): CatalogLabels {
  return { name: requiredCatalogLabel(input.name, "name"), description: requiredCatalogLabel(input.description, "description") };
}

const materialBundle = {
  kind: "Material Bundle",
  table: materialBundles,
  dataFields: [{ field: "initialMaterials", list: true }, { field: "evalInitialMaterials", list: true }],
  resource: {
    kind: "Material",
    idField: "materialId",
    table: bundleMaterials,
    id: bundleMaterials.materialId,
    fields: { bundleId: bundleMaterials.bundleId, materialId: bundleMaterials.materialId,
      name: bundleMaterials.name, description: bundleMaterials.description, byteSize: bundleMaterials.byteSize },
    prepare: (directory: BundleDirectory, owner: string, bundleId: string, input: MaterialInput, plannedId?: string) => {
      const reference = { bundleId, materialId: plannedId ?? createId() };
      const record = { ...reference, ...labels(input) };
      return {
        upload: async () => ({ ...record, byteSize: await directory.uploadInitialMaterials(owner, reference, input.files) }),
        remove: () => directory.removeInitialMaterials(owner, reference),
      };
    },
    readFiles: async (directory: BundleDirectory, owner: string, bundleId: string, materialId: string) =>
      (await directory.resolveInitialMaterials(owner, { bundleId, materialId })).map(({ path, mediaType, contentBase64 }) => {
        return { path, mediaType, byteSize: Buffer.byteLength(contentBase64, "base64"),
          readBytes: () => Buffer.from(contentBase64, "base64") };
      }),
  },
} as const satisfies BundleKind<SelectedFieldsFlat, MaterialInput>;

const sessionBundle = {
  kind: "Session Bundle",
  table: sessionBundles,
  dataFields: [{ field: "initialSession", list: false }],
  resource: {
    kind: "Session",
    idField: "sessionId",
    table: bundleSessions,
    id: bundleSessions.sessionId,
    fields: { bundleId: bundleSessions.bundleId, sessionId: bundleSessions.sessionId,
      name: bundleSessions.name, description: bundleSessions.description, format: bundleSessions.format },
    prepare: (directory: BundleDirectory, owner: string, bundleId: string, input: SessionInput, plannedId?: string) => {
      const reference = { bundleId, sessionId: plannedId ?? createId() };
      const record = { ...reference, ...labels(input), format: input.format };
      return {
        upload: async () => {
          await directory.uploadInitialSession(owner, reference, { format: input.format, content: input.content });
          return record;
        },
        remove: () => directory.removeInitialSession(owner, reference),
      };
    },
    readFiles: async (directory: BundleDirectory, owner: string, bundleId: string, sessionId: string) => {
      const { format, content } = await directory.resolveInitialSession(owner, { bundleId, sessionId });
      return [{ path: `/context.${format}`, mediaType: format === "json" ? "application/json" : "application/x-ndjson",
        byteSize: Buffer.byteLength(content, "utf8"), readBytes: () => Buffer.from(content, "utf8") }];
    },
  },
} as const satisfies BundleKind<SelectedFieldsFlat, SessionInput>;

export type MaterialRecord = SelectResultFields<typeof materialBundle.resource.fields>;
export type SessionRecord = SelectResultFields<typeof sessionBundle.resource.fields>;

/** Data content containing a reference with these IDs, as the field itself or as one element of its list. */
function hasReference(
  { field, list }: DataReferenceField, record: DataReferences | undefined, reference: InitialMaterialsRef | InitialSessionRef,
): boolean {
  const current = record?.[field];
  return list && Array.isArray(current)
    ? current.some((item) => isDeepStrictEqual(item, reference))
    : isDeepStrictEqual(current, reference);
}

function bundleRecord(row: BundleRecord): BundleRecord {
  return { bundleId: row.bundleId, name: row.name, description: row.description };
}

function resourceCondition(
  bundle: BundleKind<SelectedFieldsFlat, never>, owner: string, bundleId: string, resourceId?: string, includeDeleted = false,
) {
  const { table, id } = bundle.resource;
  return and(eq(table.ownerUserId, owner), eq(table.bundleId, bundleId), includeDeleted ? undefined : isNull(table.deletedAt),
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
  const resourceRow = (bundleId: string, resourceId?: string) => resourceCondition(bundle, owner, bundleId, resourceId);
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
  async function requireResource(bundleId: string, resourceId: string): Promise<ResourceRecord> {
    const id = platformId(bundleId, "bundleId");
    const childId = platformId(resourceId, resource.idField);
    await requireBundle(id);
    const [row] = await db.select(resource.fields).from(resource.table).where(resourceRow(id, childId));
    if (!row) throw new BundleResourceNotFoundError(resource.kind, childId);
    return row;
  }
  async function readFiles(bundleId: string, resourceId: string): Promise<readonly StoredResourceFile[]> {
    await requireResource(bundleId, resourceId);
    return resource.readFiles(directory, owner, bundleId, resourceId);
  }
  /**
   * The single resource write path: store every resource's bytes, then commit the Bundle claim and all
   * resource rows in one transaction. A failure removes every file this batch wrote.
   */
  async function importResources(
    bundleId: string, claim: (transaction: CatalogWriter) => Promise<BundleRecord>, inputs: readonly I[],
    resourceIds?: readonly string[],
  ): Promise<BundleImport<ResourceRecord>> {
    const prepared = inputs.map((input, index) => resource.prepare(directory, owner, bundleId, input, resourceIds?.[index]));
    const written: PreparedResource<ResourceRecord>[] = [];
    try {
      const imported: ResourceRecord[] = [];
      for (const item of prepared) {
        written.push(item);
        imported.push(await item.upload());
      }
      return await db.transaction(async (transaction) => {
        const claimed = await claim(transaction);
        // Drizzle cannot type an insert into a generic table; each upload yields a record of the same columns.
        if (imported.length > 0) {
          await transaction.insert(resource.table).values(imported.map((record) => ({ ...record, ownerUserId: owner })) as never);
        }
        return { bundle: claimed, imported };
      });
    } catch (error) {
      // A planned identity may have committed even if the DB response was lost. Never let an
      // overlapping retry delete that committed file (or another in-flight writer's file).
      // A rolled-back write can leave an orphan; it is safer to require manual reconciliation.
      if (resourceIds) throw error;
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
    async create(input: CatalogLabels, inputs: readonly I[] = [], planned?: PlannedBundleIdentity): Promise<BundleImport<ResourceRecord>> {
      const resourceIds = planned?.resourceIds.map((id) => platformId(id, "resourceId"));
      if (planned && (resourceIds!.length !== inputs.length || new Set(resourceIds).size !== inputs.length)) {
        throw new CatalogInputError("Planned Bundle resource IDs must match the inputs");
      }
      const created: BundleRecord = { bundleId: planned ? platformId(planned.bundleId, "bundleId") : createId(), ...labels(input) };
      return importResources(created.bundleId, async (transaction) => {
        await transaction.insert(table).values({ ...created, ownerUserId: owner });
        return created;
      }, inputs, resourceIds);
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
    getResource: requireResource,
    async listFiles(bundleId: string, resourceId: string): Promise<readonly InitialResourceFile[]> {
      return (await readFiles(bundleId, resourceId)).map(({ path, mediaType, byteSize }) => ({ path, mediaType, byteSize }));
    },
    async getFile(bundleId: string, resourceId: string, path: string): Promise<InitialResourceFileContent> {
      const file = (await readFiles(bundleId, resourceId)).find((entry) => entry.path === path);
      if (!file) throw new BundleFileError("not-found", "The file is not in this initial resource");
      const { readBytes, ...metadata } = file;
      return { ...metadata, bytes: readBytes() };
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

/** Lock an owner-scoped resource, allowing soft deletes only for a retained Data reference, and return its public record. */
async function selectableResource<F extends SelectedFieldsFlat>(
  bundle: BundleKind<F, never>, reader: Pick<EvalDb, "select">, ownerUserId: string,
  bundleId: string, resourceId: string, retained = false,
): Promise<SelectResultFields<F>> {
  const owner = requireOwnerUserId(ownerUserId);
  const { table, resource } = bundle;
  const id = platformId(resourceId, resource.idField);
  const fields: SelectedFieldsFlat = resource.fields;
  const [row] = await reader.select(fields).from(resource.table)
    .innerJoin(table, and(eq(table.bundleId, resource.table.bundleId),
      eq(table.ownerUserId, resource.table.ownerUserId)))
    .where(and(resourceCondition(bundle, owner, platformId(bundleId, "bundleId"), id, retained),
      retained ? undefined : isNull(table.deletedAt)))
    .for("share");
  if (!row) throw new BundleResourceNotFoundError(resource.kind, id);
  // Drizzle leaves rows of a generic selection unresolved; `resource.fields` fixes their shape.
  return row as SelectResultFields<F>;
}

/** Validate one Data field's Material references; together they must fit one SP initialization. */
async function assertMaterialsSelectable(
  reader: Pick<EvalDb, "select">, ownerUserId: string,
  field: (typeof materialBundle.dataFields)[number], references: readonly InitialMaterialsRef[], previous: DataReferences | undefined,
): Promise<void> {
  let byteSize = 0;
  for (const reference of references) {
    byteSize += (await selectableResource(materialBundle, reader, ownerUserId, reference.bundleId, reference.materialId,
      hasReference(field, previous, reference))).byteSize;
  }
  requireInitializationBudget(byteSize, field.field);
}

async function assertSessionSelectable(
  reader: Pick<EvalDb, "select">, ownerUserId: string, reference: InitialSessionRef, previous: DataReferences | undefined,
): Promise<void> {
  await selectableResource(sessionBundle, reader, ownerUserId, reference.bundleId, reference.sessionId,
    hasReference(sessionBundle.dataFields[0], previous, reference));
}

/** Validate every resource reference before a Data row is created or replaced. */
export async function assertDataReferencesSelectable(
  reader: Pick<EvalDb, "select">, ownerUserId: string,
  record: DataReferences, previous?: DataReferences,
): Promise<void> {
  for (const field of materialBundle.dataFields) {
    const references = record[field.field];
    if (references) await assertMaterialsSelectable(reader, ownerUserId, field, references, previous);
  }
  if (record.initialSession) await assertSessionSelectable(reader, ownerUserId, record.initialSession, previous);
}
