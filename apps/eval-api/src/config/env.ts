import { isAbsolute } from "node:path";
import { z } from "zod";

/** An HTTP(S) origin without path, query, fragment or credentials, normalized to `URL.origin`. */
export const httpOriginSchema = z.url().transform((value, context) => {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    context.addIssue({ code: "custom", message: "must be an HTTP origin without path, query or credentials" });
    return z.NEVER;
  }
  return url.origin;
});

export const absolutePathSchema = z.string().refine(isAbsolute, "must be an absolute path");

export const requiredStringSchema = z.string().trim().min(1);

export const portSchema = z.coerce.number().int().min(1).max(65_535);

export const positiveIntSchema = z.coerce.number().int().positive();

export const databaseEnvSchema = z.object({ DATABASE_URL: requiredStringSchema });

/** Parse process environment once at startup; invalid configuration stops the process. */
export function loadEnv<T extends z.ZodType>(schema: T, environment: Record<string, string | undefined>): z.output<T> {
  return schema.parse(environment);
}
