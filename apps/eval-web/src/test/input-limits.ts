import type { EvalInputLimits } from "@eval-platform/eval-contracts";

/** Test response, deliberately independent of production limits. */
export const inputLimits: EvalInputLimits = {
  materialFileBytes: 2_048, materialTotalBytes: 8_192, materialMaxFiles: 4,
  sessionContentChars: 1_000, zipArchiveBytes: 1_000_000, outputSchemaBytes: 4_096,
  datasetDocumentBytes: 65_536, promptDatasetFileBytes: 32_768, runTargetIds: 32, samplingCountMax: 12,
  comparisonProjects: 3,
};
