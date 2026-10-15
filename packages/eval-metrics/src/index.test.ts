import { describe, expect, it } from "vitest";
import * as entry from "./index.js";

describe("@eval-platform/eval-metrics", () => {
  it("exports only result interpretation, aggregation and read-only reporting", () => {
    expect(Object.keys(entry).toSorted()).toEqual([
      "aggregateMetrics", "aggregateResources", "createMetrics", "MetricsEntityNotFoundError", "MetricsQueryError", "MetricsSourceError",
      "readEvaluationMetrics", "summarizeNumbers",
    ].toSorted());
  });
});
