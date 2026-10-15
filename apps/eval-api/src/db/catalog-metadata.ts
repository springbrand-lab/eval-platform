import { platformIdSchema } from "@eval-platform/eval-dataset";
import { CatalogInputError } from "./errors.js";

export function platformId(value: string, field: string): string {
  const parsed = platformIdSchema.safeParse(value);
  if (!parsed.success) throw new CatalogInputError(`${field} must be a UUID`, field);
  return parsed.data;
}

export function requiredCatalogLabel(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CatalogInputError(`${field} must be a nonblank string`, field);
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
    throw new CatalogInputError("Metadata patch must contain name or description");
  }
  return {
    ...(input.name === undefined ? {} : { name: requiredCatalogLabel(input.name, "name") }),
    ...(input.description === undefined ? {} : { description: requiredCatalogLabel(input.description, "description") }),
  };
}
