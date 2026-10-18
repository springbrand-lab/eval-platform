import { describe, expect, it } from "vitest";
import { stageProgressLabel } from "./run-status";

describe("stageProgressLabel", () => {
  it("names an active execution or evaluation", () => {
    expect(stageProgressLabel("execution", "running")).toBe("执行中");
    expect(stageProgressLabel("evaluation", "retrying")).toBe("评估中");
  });

  it("leaves queued work as the shared queued status", () => {
    expect(stageProgressLabel("execution", "queued")).toBeUndefined();
    expect(stageProgressLabel("evaluation", "queued")).toBeUndefined();
  });
});
