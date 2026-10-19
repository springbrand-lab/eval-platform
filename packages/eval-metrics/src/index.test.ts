import { describe, expect, it } from "vitest";
import * as entry from "./index.js";

describe("@eval-platform/eval-metrics", () => {
  it("exports only read-only reporting and its errors", () => {
    expect(Object.keys(entry).toSorted()).toEqual([
      "compactResourceSnapshot", "createMetrics", "createEvaluationScoreReader", "createEvaluationResultValidator", "MetricsEntityNotFoundError", "MetricsQueryError", "MetricsSourceError",
    ].toSorted());
  });
});
