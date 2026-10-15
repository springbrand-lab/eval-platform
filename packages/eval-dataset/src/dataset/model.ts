import type { JsonValue } from "@eval-platform/eval-contracts";
import { z } from "zod";

const identifierSchema = z.string().min(1).refine((value) => value === value.trim(), {
  message: "Identifiers must not have leading or trailing whitespace",
});

const jsonValueSchema: z.ZodType<JsonValue> = z.unknown().transform((input, context) => {
  try {
    const serialized = JSON.stringify(input, function (
      this: Record<string, unknown>,
      key: string,
      value: unknown,
    ) {
      const original = this[key];
      if (!Object.is(original, value)) {
        throw new TypeError("JSON values must not depend on toJSON transformations");
      }
      if (
        original === null
        || typeof original === "string"
        || typeof original === "boolean"
        || (
          typeof original === "number"
          && Number.isFinite(original)
          && (!Number.isInteger(original) || Number.isSafeInteger(original))
        )
      ) {
        return original;
      }
      if (typeof original === "object") {
        const prototype = Object.getPrototypeOf(original);
        if (Array.isArray(original) || prototype === Object.prototype || prototype === null) {
          return original;
        }
      }
      throw new TypeError("Expected a JSON value");
    });
    if (serialized === undefined) throw new TypeError("Expected a JSON value");
    return JSON.parse(serialized) as JsonValue;
  } catch {
    context.addIssue({
      code: "custom",
      message: "Expected finite, acyclic JSON values with safe integers and without unsupported types or toJSON conversions; encode large integers as strings",
    });
    return z.NEVER;
  }
});

const jsonRecordSchema = jsonValueSchema.pipe(z.custom<Readonly<Record<string, JsonValue>>>(
  (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  "Expected a JSON object",
));

// Match SP packages/http/src/mcp-observation.ts for UUID identities persisted in PostgreSQL.
export const platformIdSchema = z.uuid().transform((value) => value.toLowerCase());
export const datasetIdSchema = platformIdSchema;
export const dataIdSchema = platformIdSchema;
const resourceReferenceIdSchema = z.union([platformIdSchema, identifierSchema]);

export const initialSessionRefSchema = z.strictObject({
  bundleId: resourceReferenceIdSchema,
  sessionId: resourceReferenceIdSchema,
}).readonly();

export const initialMaterialsRefSchema = z.strictObject({
  bundleId: resourceReferenceIdSchema,
  materialId: resourceReferenceIdSchema,
}).readonly();

const datasetFieldsSchema = z.strictObject({
  name: z.string().trim().min(1),
  description: z.string().optional(),
});

const dataFieldsSchema = z.object({
  userPrompt: z.string().refine((value) => value.trim().length > 0, {
    message: "userPrompt must not be blank",
  }),
  evalPrompt: z.string().refine((value) => value.trim().length > 0, {
    message: "evalPrompt must not be blank",
  }).optional(),
  initialSession: initialSessionRefSchema.optional(),
  initialMaterials: initialMaterialsRefSchema.optional(),
  evalInitialMaterials: initialMaterialsRefSchema.optional(),
});

export const datasetInputSchema = datasetFieldsSchema.readonly();
export const dataInputSchema = createDataRecordSchema(
  dataFieldsSchema.extend({ dataId: z.never().optional() }),
);
export const datasetSchema = datasetFieldsSchema.extend({ datasetId: datasetIdSchema }).readonly();
export const dataSchema = createDataRecordSchema(
  dataFieldsSchema.extend({ dataId: dataIdSchema }),
);

export const datasetDocumentSchema = z.strictObject({
  dataset: datasetFieldsSchema.extend({ datasetId: datasetIdSchema.optional() }).readonly(),
  data: z.array(createDataRecordSchema(
    dataFieldsSchema.extend({ dataId: dataIdSchema.optional() }),
  )).readonly(),
}).readonly().superRefine((document, context) => rejectDuplicateDataIds(document.data, context));

export const datasetSnapshotSchema = z.strictObject({
  dataset: datasetSchema,
  data: z.array(dataSchema).readonly(),
}).readonly().superRefine((snapshot, context) => rejectDuplicateDataIds(snapshot.data, context));

export type Dataset = z.infer<typeof datasetSchema>;
export type Data = z.infer<typeof dataSchema>;
export type InitialMaterialsRef = z.infer<typeof initialMaterialsRefSchema>;
export type InitialSessionRef = z.infer<typeof initialSessionRefSchema>;
export type DatasetInput = z.infer<typeof datasetInputSchema>;
export type DataInput = z.infer<typeof dataInputSchema>;
export type DatasetDocument = z.infer<typeof datasetDocumentSchema>;
export type DatasetSnapshot = z.infer<typeof datasetSnapshotSchema>;

function createDataRecordSchema<Schema extends z.ZodType<Record<string, unknown>>>(fields: Schema) {
  return jsonRecordSchema.transform((data, context) => {
    const parsed = fields.safeParse(data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) context.addIssue({ ...issue });
      return z.NEVER;
    }
    return { ...data, ...parsed.data } as Readonly<Record<string, JsonValue | undefined>> & z.output<Schema>;
  }).readonly();
}

function rejectDuplicateDataIds(
  data: readonly { readonly dataId?: string | undefined }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  data.forEach((entry, index) => {
    if (entry.dataId === undefined) return;
    if (seen.has(entry.dataId)) {
      context.addIssue({
        code: "custom",
        path: ["data", index, "dataId"],
        message: `Duplicate Data ID: ${entry.dataId}`,
      });
    }
    seen.add(entry.dataId);
  });
}
