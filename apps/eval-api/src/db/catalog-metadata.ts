import { platformIdSchema } from "@eval-platform/eval-dataset";
import { z } from "zod";
import { CatalogInputError } from "./errors.js";

/** Bundle, Material, Session, output-format and Project names and descriptions. */
export const catalogLabelSchema = z.string().trim().min(1);

export const catalogMetadataPatchSchema = z.strictObject({
  name: catalogLabelSchema.exactOptional(),
  description: catalogLabelSchema.exactOptional(),
}).refine((patch) => Object.keys(patch).length > 0, "Specify name or description");

export type CatalogMetadataPatch = z.input<typeof catalogMetadataPatchSchema>;

export function platformId(value: string, field: string): string {
  const parsed = platformIdSchema.safeParse(value);
  if (!parsed.success) throw new CatalogInputError(`${field} must be a UUID`, field);
  return parsed.data;
}

export function requiredCatalogLabel(value: string, field: string): string {
  const parsed = catalogLabelSchema.safeParse(value);
  if (!parsed.success) throw new CatalogInputError(`${field} must be a nonblank string`, field);
  return parsed.data;
}

export function parseCatalogMetadataPatch(input: CatalogMetadataPatch): z.output<typeof catalogMetadataPatchSchema> {
  const parsed = catalogMetadataPatchSchema.safeParse(input);
  if (!parsed.success) throw new CatalogInputError("Metadata patch must contain a nonblank name or description");
  return parsed.data;
}
