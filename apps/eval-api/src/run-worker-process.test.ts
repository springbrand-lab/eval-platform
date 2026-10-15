import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "./config/worker.js";

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const pool = { end: vi.fn(async () => { order.push("pool.end"); }) };
  const boss = { stop: vi.fn(async () => { order.push("boss.stop"); }) };
  const worker = { close: vi.fn(async () => { order.push("worker.close"); }) };
  const db = {};
  const store = {};
  const plans = {};
  const runQueue = {};
  const harness = {};
  const runtime = {};
  const bundles = { resolveInitialMaterials: vi.fn(), resolveInitialSession: vi.fn() };
  const evidence = {};
  return {
    order, pool, boss, worker, db, store, plans, runQueue, harness, runtime, bundles, evidence,
    openEvidenceStore: vi.fn(async (_config: unknown) => evidence),
    Pool: vi.fn(function Pool() { return pool; }),
    openBundleDirectory: vi.fn(async () => bundles),
    openRunBoss: vi.fn(async () => boss),
    createRunQueue: vi.fn(() => runQueue),
    createEvalDb: vi.fn(() => db),
    createPostgresWorkerRuntimeStore: vi.fn(() => store),
    createPostgresWorkerProjectPlanReader: vi.fn(() => plans),
    createSpHarness: vi.fn(() => harness),
    createEvalRunResumer: vi.fn((_dependencies: unknown) => runtime),
    startEvalRunWorker: vi.fn(async (_options: unknown) => worker),
  };
});

vi.mock("pg", () => ({ Pool: mocks.Pool }));
vi.mock("./sp/bundle-directory.js", () => ({ openBundleDirectory: mocks.openBundleDirectory }));
vi.mock("./evidence/store.js", () => ({ openEvidenceStore: mocks.openEvidenceStore }));
vi.mock("./run-worker-queue.js", () => ({ openRunBoss: mocks.openRunBoss, createRunQueue: mocks.createRunQueue }));
vi.mock("./db/client.js", () => ({ createEvalDb: mocks.createEvalDb }));
vi.mock("./db/runtime.js", () => ({ createPostgresWorkerRuntimeStore: mocks.createPostgresWorkerRuntimeStore }));
vi.mock("./db/project-plans.js", () => ({ createPostgresWorkerProjectPlanReader: mocks.createPostgresWorkerProjectPlanReader }));
vi.mock("./sp/harness.js", () => ({ createSpHarness: mocks.createSpHarness }));
vi.mock("@eval-platform/eval-runtime", () => ({ createEvalRunResumer: mocks.createEvalRunResumer }));
vi.mock("./worker.js", () => ({ startEvalRunWorker: mocks.startEvalRunWorker }));

import { startSpEvalRunWorkerProcess } from "./run-worker-process.js";

const config: WorkerConfig = {
  DATABASE_URL: "postgres://eval.test/db",
  EVAL_SP_AGENT_ORIGIN: "https://agent.eval-sp.test",
  EVAL_SP_SERVICE_TOKEN: "secret",
  EVAL_BUNDLE_DIR: "/bundles",
  EVAL_RUN_WORKER_CONCURRENCY: 3,
};

describe("Eval SP Run worker process", () => {
  beforeEach(() => {
    mocks.order.length = 0;
    vi.clearAllMocks();
  });

  it("composes the cross-user Store, plan reader, Eval SP Harness and Run resumer on one pg-boss instance", async () => {
    const logger = pino({ level: "silent" });
    await startSpEvalRunWorkerProcess(config, logger);

    expect(mocks.openBundleDirectory).toHaveBeenCalledExactlyOnceWith("/bundles");
    expect(mocks.openRunBoss).toHaveBeenCalledExactlyOnceWith(config.DATABASE_URL, logger, { useListenNotify: true });
    expect(mocks.Pool).toHaveBeenCalledExactlyOnceWith({ connectionString: config.DATABASE_URL });
    expect(mocks.createRunQueue).toHaveBeenCalledExactlyOnceWith(mocks.boss);
    expect(mocks.createPostgresWorkerRuntimeStore).toHaveBeenCalledExactlyOnceWith(mocks.db, mocks.runQueue);
    expect(mocks.createSpHarness).toHaveBeenCalledExactlyOnceWith({
      origin: "https://agent.eval-sp.test",
      serviceToken: "secret",
      resolveInitialMaterials: mocks.bundles.resolveInitialMaterials,
      resolveInitialSession: mocks.bundles.resolveInitialSession,
    });
    const dependencies = mocks.createEvalRunResumer.mock.calls[0]![0];
    expect(mocks.createPostgresWorkerProjectPlanReader).toHaveBeenCalledExactlyOnceWith(mocks.db);
    expect(mocks.openEvidenceStore).toHaveBeenCalledExactlyOnceWith(config);
    expect(dependencies).toMatchObject({
      store: mocks.store, harness: mocks.harness, plans: mocks.plans, evidence: mocks.evidence,
    });
    expect(dependencies).not.toHaveProperty("configResolver");
    expect(dependencies).not.toHaveProperty("getSamples");
    expect(mocks.startEvalRunWorker).toHaveBeenCalledExactlyOnceWith({
      boss: mocks.boss, runtime: mocks.runtime, store: mocks.store, logger, concurrency: 3,
    });
  });

  it("stops fetching and drains active Runs before closing pg-boss, then the pool, once", async () => {
    const workerProcess = await startSpEvalRunWorkerProcess(config, pino({ level: "silent" }));
    await Promise.all([workerProcess.close(), workerProcess.close()]);
    expect(mocks.order).toEqual(["worker.close", "boss.stop", "pool.end"]);
  });

  it("releases pg-boss and the pool when the worker cannot start", async () => {
    mocks.startEvalRunWorker.mockRejectedValueOnce(new Error("work registration failed"));
    await expect(startSpEvalRunWorkerProcess(config, pino({ level: "silent" })))
      .rejects.toThrow("work registration failed");
    expect(mocks.order).toEqual(["boss.stop", "pool.end"]);
  });
});
