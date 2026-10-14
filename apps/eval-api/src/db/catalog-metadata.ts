import { datasetIdSchema } from "@eval-platform/eval-dataset";

export function catalogId(value: string): string {
  return datasetIdSchema.parse(value);
}

export function requiredCatalogLabel(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a nonblank string`);
  }
  return value.trim();
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
