import { describe, expect, it } from "vitest";
import { createAgentScheduler, createAgentTaskQueue } from "./scheduler.js";

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

  it("drains tasks enqueued by running tasks without exceeding the limit", async () => {
    let active = 0;
    let maximum = 0;
    const queue = createAgentTaskQueue({ maxConcurrentDos: 2 });
    const completed: number[] = [];

    queue.enqueue(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      completed.push(1);
      queue.enqueue(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        completed.push(3);
        active -= 1;
      });
      active -= 1;
    });
    queue.enqueue(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      completed.push(2);
      active -= 1;
    });

    await queue.close();
    expect(completed.sort()).toEqual([1, 2, 3]);
    expect(maximum).toBe(2);
  });

  it("waits for all tasks before reporting failures", async () => {
    const queue = createAgentTaskQueue({ maxConcurrentDos: 2 });
    let completed = 0;
    queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      completed += 1;
      throw new Error("first");
    });
    queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      completed += 1;
      throw new Error("second");
    });

    await expect(queue.close()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "first" }), expect.objectContaining({ message: "second" })],
    });
    expect(completed).toBe(2);
  });
});
