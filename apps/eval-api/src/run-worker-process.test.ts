import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = {};
  const store = { listRecoverableRunIds: vi.fn() };
  const harness = { ensureAgent: vi.fn() };
  const notifications = { subscribe: vi.fn() };
  const runtime = { resume: vi.fn() };
  const worker = { close: vi.fn(async () => undefined) };
  return {
    db, store, harness, notifications, runtime, worker,
    createEvalDb: vi.fn(() => db),
    createPostgresWorkerRuntimeStore: vi.fn(() => store),
    createSpHarness: vi.fn(() => harness),
    createEvalRunResumer: vi.fn((_dependencies: unknown) => runtime),
    createPostgresRunNotifications: vi.fn(() => notifications),
    startEvalRunWorker: vi.fn(async () => worker),
  };
});

vi.mock("./db/client.js", () => ({ createEvalDb: mocks.createEvalDb }));
vi.mock("./db/runtime.js", () => ({ createPostgresWorkerRuntimeStore: mocks.createPostgresWorkerRuntimeStore }));
vi.mock("./sp/harness.js", () => ({ createSpHarness: mocks.createSpHarness }));
vi.mock("@eval-platform/eval-runtime", () => ({ createEvalRunResumer: mocks.createEvalRunResumer }));
vi.mock("./worker.js", () => ({
  createPostgresRunNotifications: mocks.createPostgresRunNotifications,
  startEvalRunWorker: mocks.startEvalRunWorker,
}));

import { startSpEvalRunWorkerProcess } from "./run-worker-process.js";

describe("Eval SP Run worker composition", () => {
  it("uses the cross-user recovery Store, Eval SP Harness and persisted Run resumer", async () => {
    const pool = {} as Pool;
    const onError = vi.fn();
    const sp = { origin: "https://eval-sp.test", serviceToken: "secret" };
    const worker = await startSpEvalRunWorkerProcess({
      pool, databaseUrl: "postgres://eval.test/db", sp,
      maxConcurrentRuns: 3, scanIntervalMs: 500, onError,
    });

    expect(worker).toBe(mocks.worker);
    expect(mocks.createEvalDb).toHaveBeenCalledExactlyOnceWith(pool);
    expect(mocks.createPostgresWorkerRuntimeStore).toHaveBeenCalledExactlyOnceWith(mocks.db);
    expect(mocks.createSpHarness).toHaveBeenCalledExactlyOnceWith(sp);
    expect(mocks.createPostgresRunNotifications).toHaveBeenCalledExactlyOnceWith("postgres://eval.test/db");
    expect(mocks.createEvalRunResumer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      store: mocks.store,
      harness: mocks.harness,
      onError,
    }));
    expect(mocks.createEvalRunResumer.mock.calls[0]![0]).toHaveProperty("getSample", expect.any(Function));
    expect(mocks.createEvalRunResumer.mock.calls[0]![0]).not.toHaveProperty("configResolver");
    expect(mocks.createEvalRunResumer.mock.calls[0]![0]).not.toHaveProperty("catalog");
    expect(mocks.startEvalRunWorker).toHaveBeenCalledExactlyOnceWith({
      runtime: mocks.runtime,
      store: mocks.store,
      notifications: mocks.notifications,
      maxConcurrentRuns: 3,
      scanIntervalMs: 500,
      onError,
    });
  });
});
