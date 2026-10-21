import type { DrizzleTransactionLike, PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { AGENT_IMPORT_QUEUE, createAgentImportQueue } from "./agent-import-queue.js";

/** Models pg-boss exclusive's unique key across created/retry/active, not only waiting jobs. */
function exclusiveBoss() {
  type Job = { id: string; singletonKey: string; state: "created" | "retry" | "active" | "completed"; startAfter?: Date };
  const jobs: Job[] = [];
  const transaction = { execute: vi.fn(async () => ({ rows: [] })) } as unknown as DrizzleTransactionLike;
  const send = vi.fn(async (_name: string, _data: unknown, options: { singletonKey: string; startAfter?: Date }) => {
    if (jobs.some((job) => job.singletonKey === options.singletonKey && job.state !== "completed")) return null;
    const job: Job = { id: `job-${jobs.length + 1}`, singletonKey: options.singletonKey, state: "created",
      ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }) };
    jobs.push(job);
    return job.id;
  });
  const complete = vi.fn(async (_name: string, id: string) => {
    const job = jobs.find((job) => job.id === id && job.state === "active");
    if (job) job.state = "completed";
    return { affected: job ? 1 : 0 };
  });
  const upsert = vi.fn(async (name: string, data: unknown, options: { singletonKey: string; startAfter: Date }) => {
    const waiting = jobs.find((job) => job.singletonKey === options.singletonKey && ["created", "retry"].includes(job.state));
    if (waiting) {
      waiting.startAfter = options.startAfter;
      return { jobs: [waiting.id], updated: 1, inserted: 0 };
    }
    const id = await send(name, data, options);
    return { jobs: id === null ? [] : [id], updated: 0, inserted: id === null ? 0 : 1 };
  });
  const boss = { send, complete, upsert } as unknown as Pick<PgBoss, "send" | "complete" | "upsert">;
  return { jobs, transaction, send, complete, upsert, queue: createAgentImportQueue(boss) };
}

describe("independent import queue", () => {
  it("keeps an apply wake-up when ready is committed but the preview delivery is still active", async () => {
    const f = exclusiveBoss();
    await f.queue.enqueue(f.transaction, "task", "preview");
    const preview = f.jobs[0]!;
    preview.state = "active"; // planner already saved ready, pg-boss has not ACKed its delivery
    await f.queue.enqueue(f.transaction, "task", "apply");
    expect(f.jobs).toHaveLength(2);
    expect(f.jobs.map((job) => job.singletonKey)).toEqual(["preview:task", "apply:task"]);
    await f.complete(AGENT_IMPORT_QUEUE, preview.id);
    expect(f.jobs[1]).toMatchObject({ singletonKey: "apply:task", state: "created" });
  });

  it("rejects a null send instead of letting a required wake-up silently disappear", async () => {
    const f = exclusiveBoss();
    await f.queue.enqueue(f.transaction, "task", "apply");
    await expect(f.queue.enqueue(f.transaction, "task", "apply")).rejects.toThrow(/wake-up/i);
    expect(f.jobs).toHaveLength(1);
  });

  it("completes and defers leases transactionally; an old automatic ACK never consumes the next delayed job", async () => {
    const f = exclusiveBoss();
    await f.queue.enqueue(f.transaction, "task", "apply");
    const old = f.jobs[0]!;
    old.state = "active";
    await f.queue.deferLease(f.transaction, "task", old.id);
    expect(old.state).toBe("completed");
    const delayed = f.jobs[1]!;
    expect(delayed).toMatchObject({ singletonKey: "lease:task", state: "created", startAfter: expect.any(Date) });
    await f.complete(AGENT_IMPORT_QUEUE, old.id); // pg-boss auto-ACK after the callback returns
    expect(delayed.state).toBe("created");
    delayed.state = "active";
    await f.queue.deferLease(f.transaction, "task", delayed.id);
    const next = f.jobs[2]!;
    expect(next.id).not.toBe(delayed.id);
    expect(next.singletonKey).toBe("lease:task"); // bounded stable key, not a random per-delivery key
    await f.complete(AGENT_IMPORT_QUEUE, delayed.id);
    expect(next.state).toBe("created");
    const firstComplete = f.complete.mock.calls[0] as unknown as [string, string, unknown, { db: unknown }];
    const firstUpsert = f.upsert.mock.calls[0] as unknown as [string, unknown, { db: unknown }];
    expect(firstComplete[3].db).toBe(firstUpsert[2].db);
  });

  it("rejects an empty lease upsert so the caller can roll back completion instead of losing the handoff", async () => {
    const complete = vi.fn(async () => ({ affected: 1 }));
    const upsert = vi.fn(async () => ({ jobs: [], updated: 0, inserted: 0 }));
    const queue = createAgentImportQueue({ complete, upsert, send: vi.fn() } as unknown as Pick<PgBoss, "send" | "complete" | "upsert">);
    await expect(queue.deferLease({ execute: vi.fn() } as unknown as DrizzleTransactionLike, "task", "old"))
      .rejects.toThrow(/wake-up/i);
  });

  it("enqueues and defers busy leases through the caller's transaction without spending a retry", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const transaction = { execute } as unknown as DrizzleTransactionLike;
    const send = vi.fn<(...args: unknown[]) => Promise<string>>(async () => "job");
    const complete = vi.fn(async () => 1);
    const upsert = vi.fn(async () => ({ jobs: ["next"], updated: 0, inserted: 1 }));
    const queue = createAgentImportQueue({ send, complete, upsert } as unknown as Pick<PgBoss, "send" | "complete" | "upsert">);
    await queue.enqueue(transaction, "task", "preview");
    expect(send).toHaveBeenCalledWith(AGENT_IMPORT_QUEUE, { taskId: "task" }, expect.objectContaining({ singletonKey: "preview:task", db: expect.any(Object) }));
    await queue.deferLease(transaction, "task", "active-job");
    expect(complete).toHaveBeenCalledWith(AGENT_IMPORT_QUEUE, "active-job", null, expect.objectContaining({ db: expect.any(Object) }));
    expect(upsert).toHaveBeenCalledWith(AGENT_IMPORT_QUEUE, { taskId: "task" },
      expect.objectContaining({ singletonKey: "lease:task", startAfter: expect.any(Date), db: expect.any(Object) }));
    const producerDb = send.mock.calls[0]![2] as unknown as { db: { executeSql(text: string, values: unknown[]): Promise<unknown> } };
    await producerDb.db.executeSql("SELECT $1", ["task"]);
    expect(execute).toHaveBeenCalledWith(expect.any(Object));
  });
});
