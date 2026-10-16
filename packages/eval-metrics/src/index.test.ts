import { describe, expect, it } from "vitest";
import * as entry from "./index.js";

describe("@eval-platform/eval-metrics", () => {
  it("exports only read-only reporting and its errors", () => {
    expect(Object.keys(entry).toSorted()).toEqual([
      "createMetrics", "createEvaluationScoreReader", "MetricsEntityNotFoundError", "MetricsQueryError", "MetricsSourceError",
    ].toSorted());
  });
});
