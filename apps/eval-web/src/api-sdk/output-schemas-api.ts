import { api, enc } from "./client";
import { deleteWithConfirmation, isConfirmedAbsent } from "./delete-confirmation";
import type { OutputSchemaRecord } from "./types";

export const outputSchemaKeys = {
  all: ["output-schemas"] as const,
  list: () => ["output-schemas", "list"] as const,
  detail: (outputSchemaId: string) => ["output-schemas", "detail", outputSchemaId] as const,
};

const base = "/api/evaluation-output-schemas";

export const listOutputSchemas = (signal?: AbortSignal) => api.get<OutputSchemaRecord[]>(base, { signal });
export const getOutputSchema = (outputSchemaId: string, signal?: AbortSignal) =>
  api.get<OutputSchemaRecord>(`${base}/${enc(outputSchemaId)}`, { signal });
export const createOutputSchema = (input: { name: string; description: string; content: string }) =>
  api.post<OutputSchemaRecord>(base, input);
export const updateOutputSchema = (outputSchemaId: string, input: { name?: string; description?: string }) =>
  api.patch<OutputSchemaRecord>(`${base}/${enc(outputSchemaId)}`, input);
export const deleteOutputSchema = (outputSchemaId: string) => deleteWithConfirmation(
  () => api.delete(`${base}/${enc(outputSchemaId)}`),
  () => isConfirmedAbsent(() => getOutputSchema(outputSchemaId), "OUTPUT_SCHEMA_NOT_FOUND"),
);
