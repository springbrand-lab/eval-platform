import { describe, expect, it } from "vitest";
import { stageInProgressCount, stageProgressLabel } from "./run-status";

describe("stageProgressLabel", () => {
  it("names an active execution or evaluation", () => {
    expect(stageProgressLabel("execution", "running")).toBe("执行中");
    expect(stageProgressLabel("evaluation", "retrying")).toBe("评估中");
  });

  it("leaves queued work as the shared queued status", () => {
    expect(stageProgressLabel("execution", "queued")).toBeUndefined();
    expect(stageProgressLabel("evaluation", "queued")).toBeUndefined();
  });

  it("counts only active records as in progress", () => {
    expect(stageInProgressCount({ statuses: { queued: 8, starting: 2, running: 3, retrying: 0, succeeded: 0, failed: 0, cancelled: 0 } })).toBe(5);
  });
});
