import { describe, expect, it } from "vitest";
import { evalInputLimitsSchema } from "./index.js";

const limits = {
  materialFileBytes: 1,
  materialTotalBytes: 1,
  materialMaxFiles: 1,
  sessionContentChars: 1,
  zipArchiveBytes: 1,
  outputSchemaBytes: 1,
  datasetDocumentBytes: 1,
  promptDatasetFileBytes: 1,
  runTargetIds: 1,
  samplingCountMax: 1,
  comparisonProjects: 2,
};

describe("control-plane input limits", () => {
  it("requires the comparison bound without owning its application value", () => {
    expect(evalInputLimitsSchema.parse(limits)).toEqual(limits);
    expect(evalInputLimitsSchema.parse({ ...limits, comparisonProjects: Number.MAX_SAFE_INTEGER }).comparisonProjects)
      .toBe(Number.MAX_SAFE_INTEGER);
    const { comparisonProjects: _comparisonProjects, ...missing } = limits;
    expect(evalInputLimitsSchema.safeParse(missing).success).toBe(false);
  });

  it.each([0, -1, 1.5, "2", null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid comparison bound %s",
    (comparisonProjects) => {
      expect(evalInputLimitsSchema.safeParse({ ...limits, comparisonProjects }).success).toBe(false);
    },
  );
});
