import { z } from "zod";

/** A file inside one initial resource; content is read separately from its immutable Bundle. */
export const initialResourceFileSchema = z.strictObject({
  path: z.string().startsWith("/").min(2),
  mediaType: z.string().min(1),
  byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export type InitialResourceFile = z.infer<typeof initialResourceFileSchema>;
