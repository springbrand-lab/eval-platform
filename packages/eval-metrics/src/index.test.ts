import { describe, expect, it } from "vitest";
import * as entry from "./index.js";

describe("@eval-platform/eval-metrics", () => {
  it("exports reporting, body-free native projection and its errors", () => {
    expect(Object.keys(entry).toSorted()).toEqual([
      "compactNativeTrajectoryRecord", "compactResourceSnapshot", "createMetrics", "createProjectComparison",
      "createEvaluationScoreReader", "createEvaluationResultValidator",
      "MetricsEntityNotFoundError", "MetricsQueryError", "MetricsSourceError",
      "NATIVE_CHARGE_LINK_VERSION", "NATIVE_PROJECTION_VERSION", "NATIVE_TOOL_CALL_KEY_PREFIX",
    ].toSorted());
  });
});
