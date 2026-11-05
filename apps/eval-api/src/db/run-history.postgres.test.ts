import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresMetricsSource } from "./metrics.js";
import { createPostgresProjectPlanReader } from "./project-plans.js";
import { createPostgresProjectRunHistoryReader } from "./run-view.js";
import { createPostgresRuntimeStore } from "./runtime.js";
import { projects, runs } from "./schema.js";
import { createTestDatabase } from "./test-database.js";
import { buildCommand, makeData, release, seedProject, settle } from "./test-fixtures.js";

const connection = process.env.DATABASE_URL;
const OWNER = "run-history-owner";

describe.skipIf(!connection)("PostgreSQL Run history", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => { database = await createTestDatabase(connection!); }, 30_000);
  afterAll(async () => { if (database) await database.destroy(); }, 30_000);

  it("lists the old Run after a full rerun replaces every member, separately from current Metrics", async () => {
    const seeded = await seedProject(database.db, OWNER, { datasets: [{ data: [makeData()] }], evaluation: true });
    const store = createPostgresRuntimeStore(database.db, OWNER, release, { enqueue: async () => {} });
    const plans = createPostgresProjectPlanReader(database.db, OWNER);
    const first = await buildCommand(plans, store, { projectId: seeded.projectId, operation: "pipeline" });
    await store.admitRun(first);
    await settle(store, first.run.samplingIds, "succeeded");
    const second = await buildCommand(plans, store, { projectId: seeded.projectId, operation: "pipeline" });
    await store.admitRun(second);

    const history = createPostgresProjectRunHistoryReader(database.db, OWNER);
    expect(await history(seeded.projectId)).toEqual({
      runs: [
        { runId: second.run.runId, sequence: 2, operation: "pipeline", retainedSamplingCount: 1, retainedEvaluationCount: 1 },
        { runId: first.run.runId, sequence: 1, operation: "pipeline", retainedSamplingCount: 0, retainedEvaluationCount: 0 },
      ],
      nextBeforeSequence: null,
    });
    expect((await createPostgresMetricsSource(database.db, OWNER).read({ projectId: seeded.projectId })).runs
      .map((run) => run.runId)).toEqual([second.run.runId]);
    expect((await database.db.select({ runId: runs.runId }).from(runs).where(eq(runs.projectId, seeded.projectId))))
      .toHaveLength(2);
    expect((await history(seeded.projectId, 2))?.runs.map((run) => run.runId)).toEqual([first.run.runId]);
    expect(await createPostgresProjectRunHistoryReader(database.db, "other-owner")(seeded.projectId)).toBeNull();
    await database.db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.projectId, seeded.projectId));
    expect(await history(seeded.projectId)).toBeNull();
  });

  it("pages all persisted Run rows by immutable sequence without dropping entries", async () => {
    const seeded = await seedProject(database.db, OWNER, { datasets: [{ data: [makeData()] }] });
    await database.db.insert(runs).values(Array.from({ length: 21 }, (_, index) => ({
      runId: `history-run-${index + 1}`, ownerUserId: OWNER, projectId: seeded.projectId, sequence: index + 1,
      sourceCommit: release.sourceCommit, operation: "execution" as const, phases: ["execution"] as const,
      selector: { all: true as const }, targets: { projectSampleIds: [seeded.samples[0]!.projectSampleId], samplingIds: [] },
      executionPlanDigest: "a".repeat(64), evaluationPlanDigest: null,
      idempotencyKey: `history-key-${index + 1}`, requestFingerprint: "fingerprint",
    })));
    const history = createPostgresProjectRunHistoryReader(database.db, OWNER);
    const first = (await history(seeded.projectId))!;
    expect(first.runs.map((run) => run.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => 21 - index));
    expect(first.nextBeforeSequence).toBe(2);
    expect(await history(seeded.projectId, first.nextBeforeSequence!)).toEqual({
      runs: [{ runId: "history-run-1", sequence: 1, operation: "execution", retainedSamplingCount: 0, retainedEvaluationCount: 0 }],
      nextBeforeSequence: null,
    });
    expect((await history(seeded.projectId, 1))?.runs).toEqual([]);
  });
});
