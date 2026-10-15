import { z } from "zod";
import { DatasetInputError } from "./store.js";

/** Read user-supplied Dataset input; any failure becomes a DatasetInputError that keeps the original cause. */
export function parseInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DatasetInputError) throw error;
    const message = error instanceof z.ZodError ? z.prettifyError(error)
      : error instanceof Error ? error.message : String(error);
    throw new DatasetInputError(message, { cause: error });
  }
}
