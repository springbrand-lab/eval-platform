import { spawnSync } from "node:child_process";
import type { AgentResourceCollection, EvaluationRecord, Sampling } from "@eval-platform/eval-contracts";
import { createMetrics } from "@eval-platform/eval-metrics";
import { eq } from "drizzle-orm";
import { Pool, types } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvalDb } from "./client.js";
import { backfillMetricFacts } from "./metric-facts.js";
import { createPostgresMetricsSource } from "./metrics.js";
import { createPostgresProjectPlanReader } from "./project-plans.js";
import { readRunView } from "./run-view.js";
import { createPostgresRuntimeStore } from "./runtime.js";
import { evaluations, samplings } from "./schema.js";
import { createTestDatabase } from "./test-database.js";
import { buildCommand, makeData, release, seedProject } from "./test-fixtures.js";

const connection = process.env.DATABASE_URL;
const owner = "metric-memory-test";

describe.skipIf(!connection)("compact persisted metric facts", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => { database = await createTestDatabase(connection!); }, 30_000);
  afterAll(async () => { if (database) await database.destroy(); }, 30_000);

  it("keeps raw evidence while project reads transfer only compact facts, including rollout backfill and CAS", async () => {
    const seeded = await seedProject(database.db, owner, { datasets: [{ data: [makeData()] }], samplingCount: 2, evaluation: true });
    const store = createPostgresRuntimeStore(database.db, owner, release, { enqueue: async () => {} });
    const command = await buildCommand(createPostgresProjectPlanReader(database.db, owner), store, { projectId: seeded.projectId, operation: "pipeline" });
    await store.admitRun(command);
    const body = "large tool output 中文".repeat(40_000);
    const resource = (id: string): AgentResourceCollection => ({ status: "collected", snapshot: {
      scope: { chatId: id, idempotencyKey: id, submissionId: id }, observedAt: "2026-10-17T00:00:00Z", finalized: true,
      coverage: { usageEvents: "complete", telemetryEvents: "complete", billingSettlements: "complete" },
      usageEvents: [], billingSettlements: [], telemetryEvents: [
        { eventId: "start", type: "tool.started", operationId: "tool", occurredAt: 1, resource: { sessionId: id }, payload: { toolName: "tool", input: body } },
        { eventId: "end", type: "tool.finished", operationId: "tool", occurredAt: 5, resource: { sessionId: id }, payload: { toolName: "tool", outcome: "completed", output: body } },
      ],
    } });
    const rawSamplings: Sampling[] = [];
    const rawEvaluations: EvaluationRecord[] = [];
    for (const original of command.samplings) {
      const record: Sampling = { ...original, execution: { status: "succeeded" }, executionAttempts: [{
        executionAttemptId: original.samplingId, samplingId: original.samplingId, attemptNumber: 1, status: "completed", resources: resource(original.samplingId),
      }] };
      await store.updateSampling(record, original);
      rawSamplings.push(record);
    }
    for (const original of command.evaluations) {
      const record: EvaluationRecord = { ...original, status: { status: "succeeded" }, attempts: [{
        evaluationAttemptId: original.evaluationId, evaluationId: original.evaluationId, attemptNumber: 1, status: "completed", resources: resource(original.evaluationId),
      }] };
      await store.updateEvaluation(record, original);
      rawEvaluations.push(record);
    }
    await expect(store.updateSampling(rawSamplings[0]!, command.samplings[0]!)).rejects.toThrow(/changed before update/);
    expect(await store.getSampling(rawSamplings[0]!.samplingId)).toEqual(rawSamplings[0]);
    expect(await store.getEvaluation(rawEvaluations[0]!.evaluationId)).toEqual(rawEvaluations[0]);

    const sizes: number[] = [];
    const parser = types.getTypeParser(3802, "text");
    const pool = new Pool({ connectionString: database.connectionString, types: {
      getTypeParser: (oid: number, format?: "text" | "binary") => oid === 3802 && format !== "binary"
        ? (value: string) => { sizes.push(Buffer.byteLength(value)); return parser(value); }
        : types.getTypeParser(oid, format),
    } });
    try {
      const measured = createEvalDb(pool);
      const source = createPostgresMetricsSource(measured, owner);
      const query = { projectId: seeded.projectId };
      const facts = await source.read(query);
      const actual = await createMetrics({ source }).getProjectOverview(query);
      const expected = await createMetrics({ source: { read: async () => ({ ...facts, samplings: rawSamplings, evaluations: rawEvaluations }) } }).getProjectOverview(query);
      expect(actual).toEqual(expected);
      expect((await readRunView(measured, command.run.runId, { kind: "owner", ownerUserId: owner }))?.run.status).toBe("succeeded");
      expect(Math.max(...sizes)).toBeLessThan(15_000);
      expect(JSON.stringify(facts)).not.toContain(body);

      const detail = await createMetrics({ source }).getSamplingDetail({ ...query, samplingId: rawSamplings[0]!.samplingId });
      expect(detail.sampling).toEqual(rawSamplings[0]);
      expect(detail.evaluations[0]!.record).toEqual(rawEvaluations[0]);
      expect(await source.read({ ...query, samplingId: rawSamplings[0]!.samplingId })).toMatchObject({ samplings: [expect.objectContaining({ samplingId: rawSamplings[0]!.samplingId })] });

      // An old process writes only raw facts: the trigger must invalidate, not serve stale success.
      await database.db.update(samplings).set({ facts: { ...rawSamplings[0]!, execution: { status: "failed" } } })
        .where(eq(samplings.samplingId, rawSamplings[0]!.samplingId));
      expect((await database.db.select({ projection: samplings.metricFacts }).from(samplings).where(eq(samplings.samplingId, rawSamplings[0]!.samplingId)))[0]!.projection).toBeNull();
      expect((await source.read(query)).samplings.find((s) => s.samplingId === rawSamplings[0]!.samplingId)?.execution.status).toBe("failed");
      await database.db.update(evaluations).set({ metricFacts: null });
      await backfillMetricFacts(database.db);
      await backfillMetricFacts(database.db);
      sizes.length = 0;
      expect((await source.read(query)).samplings.find((s) => s.samplingId === rawSamplings[0]!.samplingId)?.execution.status).toBe("failed");
      expect(Math.max(...sizes)).toBeLessThan(15_000);
    } finally { await pool.end(); }
  }, 30_000);

  it("serves a 312 MB raw project in a process with a 128 MB heap", async () => {
    const seeded = await seedProject(database.db, owner, { datasets: [{ data: [makeData()] }], samplingCount: 26 });
    const store = createPostgresRuntimeStore(database.db, owner, release, { enqueue: async () => {} });
    const command = await buildCommand(createPostgresProjectPlanReader(database.db, owner), store, { projectId: seeded.projectId, operation: "execution" });
    await store.admitRun(command);
    const body = "x".repeat(6_000_000);
    for (const original of command.samplings) {
      const resources: AgentResourceCollection = { status: "collected", snapshot: {
        scope: { chatId: original.samplingId, idempotencyKey: original.samplingId, submissionId: original.samplingId },
        observedAt: "2026-10-17T00:00:00Z", finalized: true,
        coverage: { usageEvents: "complete", telemetryEvents: "complete", billingSettlements: "complete" },
        usageEvents: [], billingSettlements: [], telemetryEvents: [
          { eventId: "s", type: "tool.started", operationId: "t", resource: { sessionId: original.samplingId }, payload: { toolName: "tool", input: body } },
          { eventId: "e", type: "tool.finished", operationId: "t", resource: { sessionId: original.samplingId }, payload: { toolName: "tool", output: body, durationMs: 1, outcome: "completed" } },
        ],
      } };
      await store.updateSampling({ ...original, execution: { status: "succeeded" }, executionAttempts: [{
        executionAttemptId: original.samplingId, samplingId: original.samplingId, attemptNumber: 1, status: "completed", resources,
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
    console.log("Metrics memory regression:", measured);
  }, 60_000);

});
