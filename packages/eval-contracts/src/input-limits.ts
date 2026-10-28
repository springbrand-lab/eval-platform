import { z } from "zod";

const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Actual control-plane bounds; values belong to the API and its public upstream contracts. */
export const evalInputLimitsSchema = z.strictObject({
  materialFileBytes: limit,
  materialTotalBytes: limit,
  materialMaxFiles: limit,
  sessionContentChars: limit,
  zipArchiveBytes: limit,
  outputSchemaBytes: limit,
  datasetDocumentBytes: limit,
  promptDatasetFileBytes: limit,
  runTargetIds: limit,
  samplingCountMax: limit,
  comparisonProjects: limit,
});

export type EvalInputLimits = z.infer<typeof evalInputLimitsSchema>;
