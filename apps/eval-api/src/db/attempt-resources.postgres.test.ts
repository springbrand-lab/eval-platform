import { spawnSync } from "node:child_process";
import {
  SP_PI_TRAJECTORY_FORMAT,
  summarizeResourceSnapshot,
  type AgentResourceSnapshot,
  type AgentResourceSnapshotDownload,
  type AgentResourceSnapshotPage,
  type EvaluationRecord,
  type Sampling,
} from "@eval-platform/eval-contracts";
import { compactNativeTrajectoryRecord, compactResourceSnapshot, createMetrics, type MetricsFacts } from "@eval-platform/eval-metrics";
import { and, eq } from "drizzle-orm";
import { Pool, types } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvalRunResumer, withoutRevision } from "@eval-platform/eval-runtime";
import type { EvidenceStore } from "@eval-platform/eval-runtime/harness";
import { createPostgresResourceSnapshotReader } from "./attempt-resources.js";
import { createEvalDb } from "./client.js";
import { createPostgresMetricsSource } from "./metrics.js";
import { createPostgresProjectPlanReader } from "./project-plans.js";
import { readRunView } from "./run-view.js";
import { createPostgresRuntimeStore } from "./runtime.js";
import { attemptResources } from "./schema.js";
import { createTestDatabase } from "./test-database.js";
import { buildCommand, makeData, release, seedProject } from "./test-fixtures.js";
import { nativeFixture, nativeToolBodyPair } from "../sp/native-test-fixture.js";
import { createSpHarness } from "../sp/harness.js";

const connection = process.env.DATABASE_URL;
const owner = "attempt-resources-test";

function rawSnapshot(id: string, body: string, toolName = "tool"): AgentResourceSnapshot {
  // Storage stress is split at the upstream 4 MB page ceiling. Both safe Pi
  // message bodies are based on the publicly projected assistant/Tool Result.
  const chunks = body.length > 3_000_000
    ? [body.slice(0, 3_000_000), body.slice(3_000_000)] : [body];
  return {
    scope: { chatId: id, idempotencyKey: id, submissionId: id }, observedAt: "2026-10-17T00:00:00Z", finalized: true,
    coverage: { usageEvents: "complete", nativeRecords: "complete", billingSettlements: "complete" },
    usageEvents: [], billingSettlements: [],
    nativeRecords: chunks.flatMap((part, index) => nativeToolBodyPair(id, id, part, toolName, index)),
  };
}

describe.skipIf(!connection)("Attempt resource snapshots stored apart from stage facts", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => { database = await createTestDatabase(connection!); }, 30_000);
  afterAll(async () => { if (database) await database.destroy(); }, 30_000);

  it("persists finalized paged resources with their Attempt revision in real PostgreSQL", async () => {
    const seeded = await seedProject(database.db, owner, { datasets: [{ data: [makeData()] }] });
    const store = createPostgresRuntimeStore(database.db, owner, release, { enqueue: async () => {} });
    const command = await buildCommand(createPostgresProjectPlanReader(database.db, owner), store, {
      projectId: seeded.projectId, operation: "execution",
    });
    await store.admitRun(command);
    const samplingId = command.run.samplingIds[0]!;
    const chatId = crypto.randomUUID();
    const submissionId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const scope = { chatId, submissionId, idempotencyKey: `execution:${samplingId}` };
    const native = await compactNativeTrajectoryRecord(nativeFixture(3, chatId, submissionId), scope);
    const summary = {
      scope, observedAt: "2026-10-28T00:00:00.000Z", finalized: true,
      readiness: { receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: 0, pendingRuntimeEvents: 0,
        actionCharges: { complete: true, unsettledExecutions: 0, missingExecutionIds: 0 } },
      coverage: { usageEvents: "complete", nativeRecords: "complete", billingSettlements: "complete" },
      counts: { usageEvents: 1, nativeRecords: 1, billingSettlements: 1 },
    } as const;
    const snapshot: AgentResourceSnapshotDownload = {
      kind: "pages", summary, creditsTotal: 1,
      async *readPages(): AsyncIterable<AgentResourceSnapshotPage> {
        yield { stream: "nativeRecords", records: [native] };
        yield { stream: "usageEvents", records: [{ eventId: "usage-1", kind: "assistant_model" }] };
        yield { stream: "billingSettlements", records: [{ eventId: "usage-1", accountId: owner,
          status: "settled", debitedUnits: 1 }] };
        yield { stream: "billingSettlements", records: [] };
      },
      dispose: async () => undefined,
    };
    const original = (await store.getSampling(samplingId))!;
    try {
      await store.updateSampling({
        ...original, subjectChatId: chatId, execution: { status: "succeeded" },
        executionAttempts: [{ executionAttemptId: attemptId, samplingId, attemptNumber: 1, status: "completed",
          submissionId, completedAt: summary.observedAt, resources: { status: "collected", summary } }],
      }, original, { attemptId, snapshot });
    } catch (error) {
      // Drizzle's message includes bound parameters; only expose the PostgreSQL SQLSTATE.
      let cause: unknown = error;
      while (cause instanceof Error && cause.cause instanceof Error) cause = cause.cause;
      const code = typeof cause === "object" && cause !== null && "code" in cause
        && typeof cause.code === "string" && /^[A-Z0-9]{5}$/.test(cause.code) ? cause.code : "unknown";
      const parameter = cause instanceof Error ? /\bparameter \$(\d+)\b/.exec(cause.message)?.[1] : undefined;
      throw new Error(`Paged resource SQL failed with SQLSTATE ${code}${parameter ? ` at bind $${parameter}` : ""}`);
    }
    const [stored] = await database.db.select({ attemptId: attemptResources.attemptId }).from(attemptResources)
      .where(and(eq(attemptResources.stage, "execution"), eq(attemptResources.recordId, samplingId)));
    expect(stored?.attemptId).toBe(attemptId);
    expect((await store.getSampling(samplingId))?.executionAttempts[0]?.resources?.status).toBe("collected");
  });

  it("collects public SP pages through Runtime into the PostgreSQL Attempt", async () => {
    const seeded = await seedProject(database.db, owner, { datasets: [{ data: [makeData()] }] });
    const store = createPostgresRuntimeStore(database.db, owner, release, { enqueue: async () => {} });
    const command = await buildCommand(createPostgresProjectPlanReader(database.db, owner), store, {
      projectId: seeded.projectId, operation: "execution",
    });
    await store.admitRun(command);
    const samplingId = command.run.samplingIds[0]!;
    const chatId = crypto.randomUUID();
    const submissionId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const key = `execution:${samplingId}`;
    const scope = { chatId, submissionId, idempotencyKey: key };
    const observedAt = "2026-10-28T00:00:00.000Z";
    const readiness = { receiptTerminal: true, stateUnreadable: false, pendingTelemetryEvents: 0, pendingRuntimeEvents: 0,
      actionCharges: { complete: true, unsettledExecutions: 0, missingExecutionIds: 0 } };
    const coverage = { usageEvents: "complete", nativeRecords: "complete", billingSettlements: "complete" } as const;
    const prefix = `/internal/v1/eval-harness/users/${encodeURIComponent(owner)}/chats/${chatId}/resources/by-key/${encodeURIComponent(key)}`;
    const paths: string[] = [];
    const harness = createSpHarness({
      origin: "https://sp.test", serviceToken: "fixture",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(new Request(input, init).url);
        paths.push(url.pathname);
        if (url.pathname === `${prefix}/readiness`) {
          return Response.json({ scope, observedAt, finalized: true, readiness });
        }
        if (url.pathname === `${prefix}/header`) {
          return Response.json({ scope, observedAt, finalized: true, readiness, coverage,
            cursor: { throughSeq: 3 }, actionCharges: [] });
        }
        if (url.pathname === `${prefix}/native-records`) {
          return Response.json({ format: SP_PI_TRAJECTORY_FORMAT, cursor: { throughSeq: 3 },
            records: [nativeFixture(3, chatId, submissionId)], nextAfterSeq: null });
        }
        if (url.pathname === `${prefix}/billing`) {
          return Response.json({ scope: { chatId, submissionId }, cursor: { throughCount: 1, sha256: "a".repeat(64) },
            after: 0, usageEvents: [{ eventId: "usage-1", kind: "assistant_model" }],
            billingSettlements: [{ eventId: "usage-1", accountId: owner, status: "settled", debitedUnits: 1 }],
            nextAfter: null });
        }
        throw new Error("Unexpected resource route");
      },
    });
    const original = (await store.getSampling(samplingId))!;
    await store.updateSampling({
      ...original, subjectChatId: chatId,
      execution: { status: "succeeded", resourcesPending: { deadline: "2026-10-28T00:10:00.000Z", nextAttemptAt: observedAt } },
      executionAttempts: [{ executionAttemptId: attemptId, samplingId, attemptNumber: 1, status: "completed",
        submissionId, completedAt: observedAt, resources: { status: "pending", scope } }],
    }, original);
    const runtime = createEvalRunResumer({
      plans: createPostgresProjectPlanReader(database.db, owner), harness, store,
      evidence: {} as EvidenceStore, now: () => observedAt, sleep: async () => undefined,
      log: () => undefined, onError: () => undefined,
    });
    await runtime.resume(command.run.runId);
    expect(paths).toContain(`${prefix}/readiness`);
    expect(paths).toContain(`${prefix}/header`);
    expect(paths).toContain(`${prefix}/native-records`);
    expect(paths).toContain(`${prefix}/billing`);
    const [stored] = await database.db.select({ snapshot: attemptResources.snapshot }).from(attemptResources)
      .where(and(eq(attemptResources.stage, "execution"), eq(attemptResources.recordId, samplingId)));
    expect((await store.getSampling(samplingId))?.executionAttempts[0]?.resources?.status).toBe("collected");
    expect(stored?.snapshot.nativeRecords).toHaveLength(1);
    expect(stored?.snapshot.usageEvents).toHaveLength(1);
    expect(stored?.snapshot.billingSettlements).toHaveLength(1);
  });

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
      const original = (await store.getSampling(samplingId))!;
      expect(original.revision).toBe(0);
      const record = { ...original, execution: { status: "succeeded" as const }, executionAttempts: [{
        executionAttemptId: samplingId, samplingId, attemptNumber: 1, status: "completed" as const,
        resources: { status: "collected" as const, summary: summarizeResourceSnapshot(snapshot) },
      }] };
      await store.updateSampling(record, original, { attemptId: samplingId, snapshot });
      await expect(store.getSampling(samplingId)).resolves.toEqual({ ...record, revision: 1 });
      await expect(store.updateSampling(record, original, { attemptId: samplingId, snapshot: rawSnapshot(samplingId, "stale") }))
        .rejects.toThrow(/changed before update/);
      storedSamplings.push(withoutRevision(record));
    }
    for (const { evaluationId } of command.evaluations) {
      const snapshot = rawSnapshot(evaluationId, body);
      raw.set(evaluationId, snapshot);
      const original = (await store.getEvaluation(evaluationId))!;
      const attempt = (resources: AgentResourceSnapshot) => ({
        evaluationAttemptId: evaluationId, evaluationId, attemptNumber: 1, status: "completed" as const,
        resources: { status: "collected" as const, summary: summarizeResourceSnapshot(resources) },
      });
      const replaced = rawSnapshot(evaluationId, "replaced");
      await store.updateEvaluation({ ...original, attempts: [attempt(replaced)] }, original, { attemptId: evaluationId, snapshot: replaced });
      const first = (await store.getEvaluation(evaluationId))!;
      const record = { ...first, status: { status: "succeeded" as const }, attempts: [attempt(snapshot)] };
      await store.updateEvaluation(record, first, { attemptId: evaluationId, snapshot });
      storedEvaluations.push(withoutRevision(record));
    }
    const rows = await database.db.select().from(attemptResources).where(eq(attemptResources.ownerUserId, owner));
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.snapshot).toEqual(raw.get(row.recordId));

    const [samplingId] = command.run.samplingIds;
    const [evaluationId] = command.run.evaluationIds;
    const reader = createPostgresResourceSnapshotReader(database.db, owner);
    const read = async (stage: "execution" | "evaluation", recordId: string, attemptId = recordId, projectId = seeded.projectId) => {
      const stream = await reader.open(projectId, stage, recordId, attemptId);
      return stream && new Response(stream).text();
    };
    for (const [stage, id] of [["execution", samplingId!], ["evaluation", evaluationId!]] as const) {
      const text = await read(stage, id);
      expect(Buffer.byteLength(text!)).toBeGreaterThan(1 << 20);
      expect(JSON.parse(text!)).toEqual(raw.get(id));
    }
    expect(await read("evaluation", samplingId!)).toBeNull();
    expect(await read("execution", samplingId!, "other")).toBeNull();
    expect(await read("execution", samplingId!, samplingId, "other-project")).toBeNull();
    expect(await createPostgresResourceSnapshotReader(database.db, "someone-else").open(seeded.projectId, "execution", samplingId!, samplingId!)).toBeNull();
    const cancelled = await reader.open(seeded.projectId, "execution", samplingId!, samplingId!);
    await cancelled!.getReader().cancel();
    expect(database.db.$client.idleCount).toBe(database.db.$client.totalCount);

    const orphan = { stage: "evaluation" as const, recordId: samplingId!, attemptId: "orphan", ownerUserId: owner, samplingId: samplingId!,
      evaluationId: null, snapshot: raw.get(samplingId!)!, metricSnapshot: raw.get(samplingId!)! };
    await expect(database.db.insert(attemptResources).values(orphan)).rejects.toMatchObject({ cause: { constraint: "eval_attempt_resources_record_ck" } });

    const sizes: number[] = [];
    const pool = new Pool({ connectionString: database.connectionString, types: {
      getTypeParser: (oid: number, format?: "text" | "binary") => {
        const parser = types.getTypeParser(oid, format);
        return (oid === 114 || oid === 3802) && format !== "binary"
          ? (value: string) => { sizes.push(Buffer.byteLength(value)); return parser(value); }
          : parser;
      },
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

  describe.each(["execution", "evaluation"] as const)("%s snapshot string round trips", (stage) => {
    it.each([
      ["an unpaired high surrogate", "\ud83e"],
      ["an unpaired low surrogate", "\udd16"],
      ["an escaped NUL", "\u0000"],
      ["normal Unicode", "\u4e2d\u6587 \u00e9 \ud83e\udd16"],
    ])("preserves %s in raw snapshots, Metrics projections and downloads", async (_name, value) => {
      const seeded = await seedProject(database.db, owner, { datasets: [{ data: [makeData()] }], evaluation: stage === "evaluation" });
      const store = createPostgresRuntimeStore(database.db, owner, release, { enqueue: async () => {} });
      const command = await buildCommand(createPostgresProjectPlanReader(database.db, owner), store, {
        projectId: seeded.projectId, operation: stage === "execution" ? "execution" : "pipeline",
      });
      await store.admitRun(command);
      const recordId = (stage === "execution" ? command.run.samplingIds[0] : command.run.evaluationIds[0])!;
      const snapshot = rawSnapshot(recordId, value, value);
      const resources = { status: "collected" as const, summary: summarizeResourceSnapshot(snapshot) };
      if (stage === "execution") {
        const original = (await store.getSampling(recordId))!;
        await store.updateSampling({ ...original, execution: { status: "succeeded" }, executionAttempts: [{
          executionAttemptId: recordId, samplingId: recordId, attemptNumber: 1, status: "completed", resources,
        }] }, original, { attemptId: recordId, snapshot });
        expect((await store.getSampling(recordId))!.executionAttempts[0]!.resources).toEqual(resources);
      } else {
        const original = (await store.getEvaluation(recordId))!;
        await store.updateEvaluation({ ...original, status: { status: "succeeded" }, attempts: [{
          evaluationAttemptId: recordId, evaluationId: recordId, attemptNumber: 1, status: "completed", resources,
        }] }, original, { attemptId: recordId, snapshot });
        expect((await store.getEvaluation(recordId))!.attempts[0]!.resources).toEqual(resources);
      }

      const [row] = await database.db.select().from(attemptResources)
        .where(and(eq(attemptResources.stage, stage), eq(attemptResources.recordId, recordId)));
      expect(row?.snapshot).toEqual(snapshot);
      const projection = await compactResourceSnapshot(snapshot);
      expect(row?.metricSnapshot).toEqual(projection);
      expect(row?.metricSnapshot.nativeRecords).toMatchObject([
        { record: { format: "pi-trajectory/v1", record: { type: "entry", value: { kind: "pi.assistant" } } },
          metricProjection: { facts: [{ type: "assistant" }, { type: "tool", toolName: value }] } },
        { record: { format: "pi-trajectory/v1", record: { type: "entry", value: { kind: "pi.toolResult" } } },
          metricProjection: { facts: [{ type: "tool", toolName: value }] } },
      ]);
      const facts = await createPostgresMetricsSource(database.db, owner).read({ projectId: seeded.projectId });
      const attempt = stage === "execution" ? facts.samplings[0]!.executionAttempts[0] : facts.evaluations[0]!.attempts[0];
      expect(attempt?.resources).toEqual({ ...resources, snapshot: projection });

      const stream = await createPostgresResourceSnapshotReader(database.db, owner).open(seeded.projectId, stage, recordId, recordId);
      expect(stream).not.toBeNull();
      const text = await new Response(stream!).text();
      expect(JSON.parse(text)).toEqual(snapshot);
      expect(text).toContain(JSON.stringify(value));
    });
  });

  it("serves a 312 MB raw project in a process with a 128 MB heap", async () => {
    const seeded = await seedProject(database.db, owner, { datasets: [{ data: [makeData()] }], samplingCount: 26 });
    const store = createPostgresRuntimeStore(database.db, owner, release, { enqueue: async () => {} });
    const command = await buildCommand(createPostgresProjectPlanReader(database.db, owner), store, { projectId: seeded.projectId, operation: "execution" });
    await store.admitRun(command);
    const body = "x".repeat(6_000_000);
    for (const { samplingId } of command.samplings) {
      const snapshot = rawSnapshot(samplingId, body);
      const original = (await store.getSampling(samplingId))!;
      await store.updateSampling({ ...original, execution: { status: "succeeded" }, executionAttempts: [{
        executionAttemptId: samplingId, samplingId, attemptNumber: 1, status: "completed",
        resources: { status: "collected", summary: summarizeResourceSnapshot(snapshot) },
      }] }, original, { attemptId: samplingId, snapshot });
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
