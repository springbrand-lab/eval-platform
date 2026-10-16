import { jsonObjectSchema, type JsonValue } from "@eval-platform/eval-contracts";
import { z } from "zod";

// Match SP packages/http/src/mcp-observation.ts for UUID identities persisted in PostgreSQL.
export const platformIdSchema = z.uuid().transform((value) => value.toLowerCase());

export const initialSessionRefSchema = z.strictObject({
  bundleId: platformIdSchema,
  sessionId: platformIdSchema,
}).readonly();

export const initialMaterialsRefSchema = z.strictObject({
  bundleId: platformIdSchema,
  materialId: platformIdSchema,
}).readonly();

/** A non-empty, ordered material list naming each `(bundleId, materialId)` at most once. */
export const initialMaterialsRefsSchema = z.array(initialMaterialsRefSchema).min(1).superRefine((refs, context) => {
  const seen = new Set<string>();
  refs.forEach(({ bundleId, materialId }, index) => {
    const key = `${bundleId}/${materialId}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: [index], message: `Duplicate material reference: ${key}` });
    seen.add(key);
  });
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
  initialMaterials: initialMaterialsRefsSchema.optional(),
  evalInitialMaterials: initialMaterialsRefsSchema.optional(),
});

export const datasetInputSchema = datasetFieldsSchema.readonly();
export const dataCreateOptionsSchema = z.strictObject({ datasetId: platformIdSchema.optional() });
export const dataInputSchema = createDataRecordSchema(
  dataFieldsSchema.extend({ dataId: z.never().optional() }),
);
export const datasetSchema = datasetFieldsSchema.extend({ datasetId: platformIdSchema }).readonly();
export const dataSchema = createDataRecordSchema(
  dataFieldsSchema.extend({ dataId: platformIdSchema }),
);

export const datasetDocumentSchema = z.strictObject({
  dataset: datasetFieldsSchema.extend({ datasetId: platformIdSchema.optional() }).readonly(),
  data: z.array(createDataRecordSchema(
    dataFieldsSchema.extend({ dataId: platformIdSchema.optional() }),
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
export type DataCreateOptions = z.infer<typeof dataCreateOptionsSchema>;
export type DatasetDocument = z.infer<typeof datasetDocumentSchema>;
export type DatasetSnapshot = z.infer<typeof datasetSnapshotSchema>;

function createDataRecordSchema<Schema extends z.ZodType<Record<string, unknown>>>(fields: Schema) {
  return jsonObjectSchema.transform((data, context) => {
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
