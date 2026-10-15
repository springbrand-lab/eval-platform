import type { EvaluationOutputSchema } from "@eval-platform/eval-contracts";
import { and, eq, isNull } from "drizzle-orm";
import { parseEvaluationOutputSchema } from "../project-output-schema.js";
import type { EvalDb } from "./client.js";
import { parseCatalogMetadataPatch, platformId, requiredCatalogLabel, type CatalogMetadataPatch } from "./catalog-metadata.js";
import { OutputSchemaNotFoundError } from "./errors.js";
import { requireOwnerUserId } from "./owner.js";
import { evaluationOutputSchemas } from "./schema.js";

export interface OutputSchemaRecord {
  readonly outputSchemaId: string;
  readonly name: string;
  readonly description: string;
  readonly schema: EvaluationOutputSchema;
}

function toRecord(row: typeof evaluationOutputSchemas.$inferSelect): OutputSchemaRecord {
  return {
    outputSchemaId: row.outputSchemaId,
    name: row.name,
    description: row.description,
    schema: row.schema,
  };
}

/**
 * Owner-scoped immutable JSON Schema uploads. Soft deletes only hide entries from new selection:
 * evaluation plans keep reading the content by ID, so a referenced Schema may still be soft-deleted.
 */
export function createOutputSchemaCatalog(db: EvalDb, ownerUserId: string) {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    async create(input: { name: string; description: string; content: string }): Promise<OutputSchemaRecord> {
      const name = requiredCatalogLabel(input.name, "name");
      const description = requiredCatalogLabel(input.description, "description");
      const schema = parseEvaluationOutputSchema(input.content);
      const record = { outputSchemaId: crypto.randomUUID(), ownerUserId: owner, name, description, schema };
      await db.insert(evaluationOutputSchemas).values(record);
      return toRecord({ ...record, deletedAt: null });
    },
    async list(): Promise<readonly OutputSchemaRecord[]> {
      const rows = await db.select().from(evaluationOutputSchemas)
        .where(and(eq(evaluationOutputSchemas.ownerUserId, owner), isNull(evaluationOutputSchemas.deletedAt)))
        .orderBy(evaluationOutputSchemas.outputSchemaId);
      return rows.map(toRecord);
    },
    async get(outputSchemaId: string): Promise<OutputSchemaRecord | null> {
      const [row] = await db.select().from(evaluationOutputSchemas).where(and(
        eq(evaluationOutputSchemas.ownerUserId, owner),
        eq(evaluationOutputSchemas.outputSchemaId, platformId(outputSchemaId, "outputSchemaId")),
        isNull(evaluationOutputSchemas.deletedAt),
      ));
      return row ? toRecord(row) : null;
    },
    async updateMetadata(outputSchemaId: string, input: CatalogMetadataPatch): Promise<OutputSchemaRecord> {
      const id = platformId(outputSchemaId, "outputSchemaId");
      const patch = parseCatalogMetadataPatch(input);
      const [row] = await db.update(evaluationOutputSchemas).set(patch).where(and(
        eq(evaluationOutputSchemas.ownerUserId, owner), eq(evaluationOutputSchemas.outputSchemaId, id),
        isNull(evaluationOutputSchemas.deletedAt),
      )).returning();
      if (!row) throw new OutputSchemaNotFoundError(id);
      return toRecord(row);
    },
    async delete(outputSchemaId: string): Promise<void> {
      const id = platformId(outputSchemaId, "outputSchemaId");
      const [deleted] = await db.update(evaluationOutputSchemas).set({ deletedAt: new Date() }).where(and(
        eq(evaluationOutputSchemas.ownerUserId, owner), eq(evaluationOutputSchemas.outputSchemaId, id),
        isNull(evaluationOutputSchemas.deletedAt),
      )).returning({ outputSchemaId: evaluationOutputSchemas.outputSchemaId });
      if (!deleted) throw new OutputSchemaNotFoundError(id);
    },
  };
}
