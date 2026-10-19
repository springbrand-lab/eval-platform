import { spawnSync } from "node:child_process";
import { summarizeResourceSnapshot, type AgentResourceSnapshot, type EvaluationRecord, type Sampling } from "@eval-platform/eval-contracts";
import { createMetrics, type MetricsFacts } from "@eval-platform/eval-metrics";
import { and, eq } from "drizzle-orm";
import { Pool, types } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvalDb } from "./client.js";
import { createPostgresMetricsSource } from "./metrics.js";
import { createPostgresProjectPlanReader } from "./project-plans.js";
import { readRunView } from "./run-view.js";
import { createPostgresRuntimeStore } from "./runtime.js";
import { attemptResources } from "./schema.js";
import { createTestDatabase } from "./test-database.js";
import { buildCommand, makeData, release, seedProject } from "./test-fixtures.js";

const connection = process.env.DATABASE_URL;
const owner = "attempt-resources-test";

function rawSnapshot(id: string, body: string): AgentResourceSnapshot {
  return {
    scope: { chatId: id, idempotencyKey: id, submissionId: id }, observedAt: "2026-10-17T00:00:00Z", finalized: true,
    coverage: { usageEvents: "complete", telemetryEvents: "complete", billingSettlements: "complete" },
    usageEvents: [], billingSettlements: [], telemetryEvents: [
      { eventId: "start", type: "tool.started", operationId: "tool", occurredAt: 1, resource: { sessionId: id }, payload: { toolName: "tool", input: body } },
      { eventId: "end", type: "tool.finished", operationId: "tool", occurredAt: 5, resource: { sessionId: id }, payload: { toolName: "tool", outcome: "completed", output: body } },
    ],
  };
}

describe.skipIf(!connection)("Attempt resource snapshots stored apart from stage facts", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => { database = await createTestDatabase(connection!); }, 30_000);
  afterAll(async () => { if (database) await database.destroy(); }, 30_000);

  it("keeps raw snapshots unchanged while stage, Run and Metrics reads transfer only summaries and projections", async () => {
    const seeded = await seedProject(database.db, owner, { datasets: [{ data: [makeData()] }], samplingCount: 2, evaluation: true });
    const store = createPostgresRuntimeStore(database.db, owner, release, { enqueue: async () => {} });
    const command = await buildCommand(createPostgresProjectPlanReader(database.db, owner), store, { projectId: seeded.projectId, operation: "pipeline" });
    await store.admitRun(command);
    const body = "large tool output 中文".repeat(40_000);
    const raw = new Map<string, AgentResourceSnapshot>();
    const storedSamplings: Sampling[] = [];
    const storedEvaluations: EvaluationRecord[] = [];
    for (const { samplingId } of command.samplings) {
      const snapshot = rawSnapshot(samplingId, body);
      raw.set(samplingId, snapshot);
      await store.saveResourceSnapshot({ samplingId, attemptId: samplingId }, snapshot);
      const original = (await store.getSampling(samplingId))!;
      expect(original.revision).toBe(0);
      const record = { ...original, execution: { status: "succeeded" as const }, executionAttempts: [{
        executionAttemptId: samplingId, samplingId, attemptNumber: 1, status: "completed" as const,
        resources: { status: "collected" as const, summary: summarizeResourceSnapshot(snapshot) },
      }] };
      await store.updateSampling(record, original);
      await expect(store.getSampling(samplingId)).resolves.toEqual({ ...record, revision: 1 });
      await expect(store.updateSampling(record, original)).rejects.toThrow(/changed before update/);
      const { revision: _revision, ...facts } = record;
      storedSamplings.push(facts);
    }
    for (const { evaluationId, samplingId } of command.evaluations) {
      const snapshot = rawSnapshot(evaluationId, body);
      raw.set(evaluationId, snapshot);
      await store.saveResourceSnapshot({ samplingId, evaluationId, attemptId: evaluationId }, rawSnapshot(evaluationId, "replaced"));
      await store.saveResourceSnapshot({ samplingId, evaluationId, attemptId: evaluationId }, snapshot);
      const original = (await store.getEvaluation(evaluationId))!;
      const record = { ...original, status: { status: "succeeded" as const }, attempts: [{
        evaluationAttemptId: evaluationId, evaluationId, attemptNumber: 1, status: "completed" as const,
        resources: { status: "collected" as const, summary: summarizeResourceSnapshot(snapshot) },
      }] };
      await store.updateEvaluation(record, original);
      const { revision: _revision, ...facts } = record;
      storedEvaluations.push(facts);
    }
    const rows = await database.db.select().from(attemptResources).where(eq(attemptResources.ownerUserId, owner));
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.snapshot).toEqual(raw.get(row.recordId));
    await expect(store.saveResourceSnapshot({ samplingId: "missing", attemptId: "a" }, rawSnapshot("missing", ""))).rejects.toThrow(/sampling/);

    const sizes: number[] = [];
    const parser = types.getTypeParser(3802, "text");
    const pool = new Pool({ connectionString: database.connectionString, types: {
      getTypeParser: (oid: number, format?: "text" | "binary") => oid === 3802 && format !== "binary"
        ? (value: string) => { sizes.push(Buffer.byteLength(value)); return parser(value); }
        : types.getTypeParser(oid, format),
    } });
    try {
      const measured = createEvalDb(pool);
      const measuredStore = createPostgresRuntimeStore(measured, owner, release, { enqueue: async () => {} });
      await measuredStore.getSamplings(command.run.samplingIds);
      await measuredStore.getEvaluations(command.run.evaluationIds);
      expect((await readRunView(measured, command.run.runId, { kind: "owner", ownerUserId: owner }))?.run.status).toBe("succeeded");
      const source = createPostgresMetricsSource(measured, owner);
      const query = { projectId: seeded.projectId };
      const facts = await source.read(query);
      expect(Math.max(...sizes)).toBeLessThan(15_000);
      expect(JSON.stringify(facts)).not.toContain(body);

      const withRaw = <T extends { readonly resources?: unknown }>(attempt: T, id: string) => ({
        ...attempt, resources: { ...attempt.resources as object, snapshot: raw.get(id)! },
      });
      const expected = await createMetrics({ source: { read: async () => ({
        ...facts,
        samplings: storedSamplings.map((record) => ({ ...record, executionAttempts: record.executionAttempts.map((attempt) => withRaw(attempt, attempt.executionAttemptId)) })),
        evaluations: storedEvaluations.map((record) => ({ ...record, attempts: record.attempts.map((attempt) => withRaw(attempt, attempt.evaluationAttemptId)) })),
      }) as MetricsFacts } }).getProjectOverview(query);
      expect(await createMetrics({ source }).getProjectOverview(query)).toEqual(expected);

      const detail = await createMetrics({ source }).getSamplingDetail({ ...query, samplingId: storedSamplings[0]!.samplingId });
      expect(detail.sampling).toEqual(storedSamplings[0]);
      expect(detail.evaluations[0]!.record).toEqual(storedEvaluations[0]);
    } finally { await pool.end(); }

    const replacement = await buildCommand(createPostgresProjectPlanReader(database.db, owner), store, { projectId: seeded.projectId, operation: "execution" });
    await store.admitRun(replacement);
    expect(await database.db.select({ id: attemptResources.recordId }).from(attemptResources)
      .where(and(eq(attemptResources.ownerUserId, owner)))).toEqual([]);
  }, 30_000);

  it("serves a 312 MB raw project in a process with a 128 MB heap", async () => {
    const seeded = await seedProject(database.db, owner, { datasets: [{ data: [makeData()] }], samplingCount: 26 });
    const store = createPostgresRuntimeStore(database.db, owner, release, { enqueue: async () => {} });
    const command = await buildCommand(createPostgresProjectPlanReader(database.db, owner), store, { projectId: seeded.projectId, operation: "execution" });
    await store.admitRun(command);
    const body = "x".repeat(6_000_000);
    for (const { samplingId } of command.samplings) {
      const snapshot = rawSnapshot(samplingId, body);
      await store.saveResourceSnapshot({ samplingId, attemptId: samplingId }, snapshot);
      const original = (await store.getSampling(samplingId))!;
      await store.updateSampling({ ...original, execution: { status: "succeeded" }, executionAttempts: [{
        executionAttemptId: samplingId, samplingId, attemptNumber: 1, status: "completed",
        resources: { status: "collected", summary: summarizeResourceSnapshot(snapshot) },
      }] }, original);
    }
    const script = `
      import { Pool } from 'pg';
      import { createEvalDb } from './src/db/client.ts';
      import { createPostgresMetricsSource } from './src/db/metrics.ts';
      import { createMetrics } from '@eval-platform/eval-metrics';
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      try {
        const result = await createMetrics({ source: createPostgresMetricsSource(createEvalDb(pool), ${JSON.stringify(owner)}) })
          .getProjectOverview({ projectId: ${JSON.stringify(seeded.projectId)} });
        console.log(JSON.stringify({ count: result.summary.counts.samplings, bytes: Buffer.byteLength(JSON.stringify(result)), heap: process.memoryUsage().heapUsed }));
      } finally { await pool.end(); }
    `;
    const child = spawnSync(process.execPath, ["--max-old-space-size=128", "--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, DATABASE_URL: database.connectionString }, encoding: "utf8", timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(0);
    const measured = JSON.parse(child.stdout.trim());
    expect(measured.count).toBe(26);
    expect(measured.bytes).toBeLessThan(1_000_000);
    expect(measured.heap).toBeLessThan(128 * 1024 * 1024);
  }, 60_000);
});
