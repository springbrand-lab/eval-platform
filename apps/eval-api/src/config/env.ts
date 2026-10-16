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

/** The Langfuse project Eval SP reports to; scores are synced only when URL and both keys are set. */
export const langfuseEnvShape = {
  LANGFUSE_BASE_URL: httpOriginSchema.optional(),
  LANGFUSE_PUBLIC_KEY: requiredStringSchema.optional(),
  LANGFUSE_SECRET_KEY: requiredStringSchema.optional(),
  /** Must match the environment Eval SP reports its traces under. */
  LANGFUSE_ENVIRONMENT: requiredStringSchema.optional(),
};

type LangfuseEnv = { readonly [Key in keyof typeof langfuseEnvShape]?: z.output<(typeof langfuseEnvShape)[Key]> };

export function refineLangfuseEnv(value: LangfuseEnv, context: z.RefinementCtx): void {
  const set = [value.LANGFUSE_BASE_URL, value.LANGFUSE_PUBLIC_KEY, value.LANGFUSE_SECRET_KEY]
    .filter((item) => item !== undefined).length;
  if (set !== 0 && set !== 3) {
    context.addIssue({
      code: "custom",
      path: ["LANGFUSE_BASE_URL"],
      message: "LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set together",
    });
  }
}

/** Split the Langfuse settings out of a parsed environment. */
export function takeLangfuseConfig<T extends LangfuseEnv>(value: T): Omit<T, keyof LangfuseEnv> & {
  readonly langfuse?: { baseUrl: string; publicKey: string; secretKey: string; environment?: string };
} {
  const {
    LANGFUSE_BASE_URL: baseUrl, LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey,
    LANGFUSE_ENVIRONMENT: environment, ...rest
  } = value;
  if (baseUrl === undefined || publicKey === undefined || secretKey === undefined) return rest;
  return { ...rest, langfuse: { baseUrl, publicKey, secretKey, ...(environment === undefined ? {} : { environment }) } };
}
