import { describe, expect, it } from "vitest";
import { createAgentScheduler } from "./scheduler.js";

describe("agent scheduler", () => {
  it("limits active tasks and preserves task order", async () => {
    let active = 0;
    let maximum = 0;
    const scheduler = createAgentScheduler({ maxConcurrentDos: 2 });
    const tasks = Array.from({ length: 5 }, (_, index) => async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return index;
    });

    await expect(scheduler.run(tasks)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(maximum).toBe(2);
  });
});
