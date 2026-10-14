import type { EvaluationOutputSchema } from "@eval-platform/eval-contracts";
import { datasetIdSchema } from "@eval-platform/eval-dataset";
import { and, eq, isNull } from "drizzle-orm";
import { parseEvaluationOutputSchema, MAX_EVALUATION_OUTPUT_SCHEMA_BYTES } from "../project-output-schema.js";
import { parseStrictJson } from "../strict-json.js";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { evaluationOutputSchemas } from "./schema.js";

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

export function requiredCatalogLabel(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a nonblank string`);
  }
  return value.trim();
}

export function catalogId(value: string): string {
  return datasetIdSchema.parse(value);
}

export interface CatalogMetadataPatch {
  readonly name?: string;
  readonly description?: string;
}

export function parseCatalogMetadataPatch(input: CatalogMetadataPatch): CatalogMetadataPatch {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).length === 0 || Object.keys(input).some((key) => key !== "name" && key !== "description") ||
    (Object.hasOwn(input, "name") && input.name === undefined) ||
    (Object.hasOwn(input, "description") && input.description === undefined)) {
    throw new TypeError("Metadata patch must contain name or description");
  }
  return {
    ...(input.name === undefined ? {} : { name: requiredCatalogLabel(input.name, "name") }),
    ...(input.description === undefined ? {} : { description: requiredCatalogLabel(input.description, "description") }),
  };
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
      const rows = await db.update(evaluationOutputSchemas).set({ deletedAt: new Date() }).where(and(
        eq(evaluationOutputSchemas.ownerUserId, owner), eq(evaluationOutputSchemas.outputSchemaId, id),
        isNull(evaluationOutputSchemas.deletedAt),
      )).returning({ outputSchemaId: evaluationOutputSchemas.outputSchemaId });
      if (rows.length === 0) throw new OutputSchemaNotFoundError(id);
    },
  };
}
