import type { EvaluationOutputSchema } from "@eval-platform/eval-contracts";
import { and, eq, isNull } from "drizzle-orm";
import { parseEvaluationOutputSchema, MAX_EVALUATION_OUTPUT_SCHEMA_BYTES } from "../project-output-schema.js";
import { parseStrictJson } from "@eval-platform/eval-dataset";
import type { EvalDb } from "./client.js";
import { catalogId, parseCatalogMetadataPatch, requiredCatalogLabel, type CatalogMetadataPatch } from "./catalog-metadata.js";
import { requireOwnerUserId } from "./owner.js";
import { evaluationOutputSchemas, projects } from "./schema.js";

export interface OutputSchemaRecord {
  readonly outputSchemaId: string;
  readonly name: string;
  readonly description: string;
  readonly schema: EvaluationOutputSchema;
}

export class OutputSchemaNotFoundError extends Error {
  constructor(outputSchemaId: string) {
    super(`Unknown output format ${outputSchemaId}`);
    this.name = "OutputSchemaNotFoundError";
  }
}

export class OutputSchemaInUseError extends Error {
  constructor(outputSchemaId: string) {
    super(`Output format is still bound to a Project: ${outputSchemaId}`);
    this.name = "OutputSchemaInUseError";
  }
}

function toRecord(row: typeof evaluationOutputSchemas.$inferSelect): OutputSchemaRecord {
  return {
    outputSchemaId: row.outputSchemaId,
    name: row.name,
    description: row.description,
    schema: row.schema,
  };
}

/** Owner-scoped immutable JSON Schema uploads; soft deletes hide entries from new selection. */
export function createOutputSchemaCatalog(db: EvalDb, ownerUserId: string) {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    async create(input: { name: string; description: string; content: string }): Promise<OutputSchemaRecord> {
      const name = requiredCatalogLabel(input.name, "name");
      const description = requiredCatalogLabel(input.description, "description");
      if (typeof input.content !== "string") throw new TypeError("content must be JSON Schema file text");
      if (Buffer.byteLength(input.content, "utf8") > MAX_EVALUATION_OUTPUT_SCHEMA_BYTES) {
        throw new RangeError("Evaluation output JSON Schema is too large");
      }
      const schema = parseEvaluationOutputSchema(parseStrictJson(input.content));
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
        eq(evaluationOutputSchemas.outputSchemaId, catalogId(outputSchemaId)),
        isNull(evaluationOutputSchemas.deletedAt),
      ));
      return row ? toRecord(row) : null;
    },
    async updateMetadata(outputSchemaId: string, input: CatalogMetadataPatch): Promise<OutputSchemaRecord> {
      const id = catalogId(outputSchemaId);
      const patch = parseCatalogMetadataPatch(input);
      const [row] = await db.update(evaluationOutputSchemas).set(patch).where(and(
        eq(evaluationOutputSchemas.ownerUserId, owner), eq(evaluationOutputSchemas.outputSchemaId, id),
        isNull(evaluationOutputSchemas.deletedAt),
      )).returning();
      if (!row) throw new OutputSchemaNotFoundError(id);
      return toRecord(row);
    },
    async delete(outputSchemaId: string): Promise<void> {
      const id = catalogId(outputSchemaId);
      await db.transaction(async (transaction) => {
        const [selected] = await transaction.select({ outputSchemaId: evaluationOutputSchemas.outputSchemaId })
          .from(evaluationOutputSchemas).where(and(
            eq(evaluationOutputSchemas.ownerUserId, owner), eq(evaluationOutputSchemas.outputSchemaId, id),
            isNull(evaluationOutputSchemas.deletedAt),
          )).for("update");
        if (!selected) throw new OutputSchemaNotFoundError(id);
        const [bound] = await transaction.select({ projectId: projects.projectId }).from(projects)
          .where(and(eq(projects.ownerUserId, owner), eq(projects.evaluationOutputSchemaId, id)))
          .limit(1);
        if (bound) throw new OutputSchemaInUseError(id);
        await transaction.update(evaluationOutputSchemas).set({ deletedAt: new Date() })
          .where(eq(evaluationOutputSchemas.outputSchemaId, id));
      });
    },
  };
}
