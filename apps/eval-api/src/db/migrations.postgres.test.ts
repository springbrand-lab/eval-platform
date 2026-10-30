import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { summarizeResourceSnapshot, type AgentResourceSnapshot } from "@eval-platform/eval-contracts";
import { compactResourceSnapshot } from "@eval-platform/eval-metrics";
import { eq, sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresManagementStore } from "../eval-management/store.js";
import { createPostgresResourceSnapshotReader } from "./attempt-resources.js";
import { createPostgresMetricsSource } from "./metrics.js";
import { migrateDatabase } from "./migrations.js";
import { createPostgresProjectPlanReader } from "./project-plans.js";
import { createPostgresRuntimeStore } from "./runtime.js";
import { attemptResources, data, datasetData, datasets } from "./schema.js";
import { createTestDatabase } from "./test-database.js";
import { buildCommand, makeData, release, seedProject } from "./test-fixtures.js";
import { nativeToolBodyPair } from "../sp/native-test-fixture.js";

const connection = process.env.DATABASE_URL;
const migrationsFolder = path.resolve("migrations-postgres");

describe.skipIf(!connection)("deployment database migrations", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "eval-migration-history-"));
  }, 30_000);

  beforeEach(async () => {
    database = await createTestDatabase(connection!);
  }, 30_000);

  afterEach(async () => {
    if (database) await database.destroy();
  }, 30_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it("rejects an edited applied migration without changing its history or existing data", async () => {
    const changedFolder = path.join(directory, "changed");
    await cp(migrationsFolder, changedFolder, { recursive: true });
    await appendFile(path.join(changedFolder, "0000_initial.sql"), "\n-- A baseline edited after it was deployed.\n");
    const datasetId = crypto.randomUUID();
    await database.db.insert(datasets).values({ datasetId, ownerUserId: "migration-test", kind: "general", name: "Preserved" });
    const before = await database.db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`);

    await expect(migrateDatabase(database.db, { migrationsFolder: changedFolder }))
      .rejects.toThrow(/migration history/i);

    expect((await database.db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`)).rows).toEqual(before.rows);
    expect((await database.db.select().from(datasets)).some((row) => row.datasetId === datasetId)).toBe(true);
  });

  it("allows a repeat deployment of the same schema", async () => {
    await expect(migrateDatabase(database.db, { migrationsFolder })).resolves.toBeUndefined();
  });

  it("rejects missing business structure even when the recorded migration hash matches", async () => {
    await database.db.execute(sql`ALTER TABLE eval_bundle_materials DROP COLUMN byte_size`);
    await expect(migrateDatabase(database.db, { migrationsFolder })).rejects.toThrow();
  });

  it("rejects a database with migrations unknown to this release", async () => {
    await database.db.execute(sql`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      SELECT ${"unknown"}, max(created_at) + 1 FROM drizzle.__drizzle_migrations
    `);
    await expect(migrateDatabase(database.db, { migrationsFolder })).rejects.toThrow(/migration history/i);
  });

  it("applies a new migration after an unchanged applied prefix", async () => {
    const nextFolder = path.join(directory, "next");
    await cp(migrationsFolder, nextFolder, { recursive: true });
    const journalPath = path.join(nextFolder, "meta/_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const previous = journal.entries.at(-1);
    journal.entries.push({ ...previous, idx: previous.idx + 1, when: previous.when + 1, tag: "0001_probe" });
    await writeFile(journalPath, JSON.stringify(journal));
    await writeFile(path.join(nextFolder, "0001_probe.sql"), "CREATE TABLE migration_probe (id integer PRIMARY KEY);");

    await migrateDatabase(database.db, { migrationsFolder: nextFolder });

    expect((await database.db.execute<{ name: string }>(sql`SELECT to_regclass('public.migration_probe') AS name`)).rows[0]?.name)
      .toBe("migration_probe");
    await expect(migrateDatabase(database.db, { migrationsFolder: nextFolder })).resolves.toBeUndefined();
  });
});

describe.skipIf(!connection)("Dataset membership order migration", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "eval-dataset-order-upgrade-"));
    await cp(migrationsFolder, directory, { recursive: true });
    const journalPath = path.join(directory, "meta/_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 10);
    await writeFile(journalPath, JSON.stringify(journal));
    database = await createTestDatabase(connection!, (db) => migrate(db, { migrationsFolder: directory }));
  }, 30_000);

  afterAll(async () => {
    if (database) await database.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it("retains the unchanged applied prefix and legacy unknowns, then accepts unique known positions", async () => {
    const { db } = database;
    const datasetId = crypto.randomUUID();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    // The fixture predates 0011/0012, so avoid issuing an INSERT with current-schema columns.
    await db.execute(sql`INSERT INTO eval_datasets (dataset_id, owner_user_id, kind, name)
      VALUES (${datasetId}, ${"migration-test"}, 'general', 'Legacy')`);
    await db.insert(data).values([
      { dataId: first, ownerUserId: "migration-test", content: { userPrompt: "first" } },
      { dataId: second, ownerUserId: "migration-test", content: { userPrompt: "second" } },
    ]);
    await db.execute(sql`INSERT INTO eval_dataset_data (owner_user_id, dataset_id, data_id)
      VALUES (${"migration-test"}, ${datasetId}, ${first}), (${"migration-test"}, ${datasetId}, ${second})`);
    const before = (await db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`)).rows;
    expect(before).toHaveLength(11);
    expect((await db.execute(sql`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'eval_dataset_data' AND column_name = 'position'`)).rows).toEqual([]);

    await migrateDatabase(db, { migrationsFolder });
    const history = (await db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`)).rows;
    expect(history.slice(0, before.length)).toEqual(before);
    expect(history).toHaveLength(readMigrationFiles({ migrationsFolder }).length);
    expect((await db.select().from(datasetData).where(eq(datasetData.datasetId, datasetId)))
      .map((row) => row.position)).toEqual([null, null]);
    expect((await db.select().from(datasets).where(eq(datasets.datasetId, datasetId)))[0]?.originalOrderIntact)
      .toBeNull();
    await db.update(datasetData).set({ position: 0 }).where(eq(datasetData.dataId, first));
    await expect(db.update(datasetData).set({ position: 0 }).where(eq(datasetData.dataId, second)))
      .rejects.toThrow(); // Same Dataset cannot have two known members at the same position.
    await expect(db.update(datasetData).set({ position: -1 }).where(eq(datasetData.dataId, second)))
      .rejects.toThrow();
    await db.update(datasetData).set({ position: 1 }).where(eq(datasetData.dataId, second));
    await expect(migrateDatabase(db, { migrationsFolder })).resolves.toBeUndefined();
    expect((await db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`)).rows).toEqual(history);
  }, 30_000);
});

describe.skipIf(!connection)("Dataset original-order provenance upgrade", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "eval-dataset-provenance-upgrade-"));
    await cp(migrationsFolder, directory, { recursive: true });
    const journalPath = path.join(directory, "meta/_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 11);
    await writeFile(journalPath, JSON.stringify(journal));
    database = await createTestDatabase(connection!, (db) => migrate(db, { migrationsFolder: directory }));
  }, 30_000);

  afterAll(async () => {
    if (database) await database.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it("keeps 0011 known positions but does not invent original-order provenance for existing Datasets", async () => {
    const { db } = database;
    const owner = "provenance-upgrade-test";
    const datasetId = crypto.randomUUID();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    // 0011 positions 0,1 are ambiguous: a prior detach-all/readd also produces 0,1.
    await db.execute(sql`INSERT INTO eval_datasets (dataset_id, owner_user_id, kind, name)
      VALUES (${datasetId}, ${owner}, 'general', 'Before upgrade')`);
    await db.insert(data).values([
      { dataId: first, ownerUserId: owner, content: { userPrompt: "first" } },
      { dataId: second, ownerUserId: owner, content: { userPrompt: "second" } },
    ]);
    await db.execute(sql`INSERT INTO eval_dataset_data (owner_user_id, dataset_id, data_id, position)
      VALUES (${owner}, ${datasetId}, ${second}, 0), (${owner}, ${datasetId}, ${first}, 1)`);
    const before = (await db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`)).rows;
    expect(before).toHaveLength(12);

    await migrateDatabase(db, { migrationsFolder });
    const history = (await db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`)).rows;
    expect(history.slice(0, before.length)).toEqual(before);
    expect(history).toHaveLength(readMigrationFiles({ migrationsFolder }).length);
    expect((await db.select().from(datasetData).where(eq(datasetData.datasetId, datasetId)))
      .map(({ position }) => position).sort()).toEqual([0, 1]);
    expect((await db.select().from(datasets).where(eq(datasets.datasetId, datasetId)))[0]?.originalOrderIntact)
      .toBeNull();
    const management = createPostgresManagementStore(db);
    expect(await management.listDatasetData(owner, datasetId, 1, 5)).toMatchObject({
      order: "unknown", total: 2, items: [{ dataId: second }, { dataId: first }],
    });
    await expect(migrateDatabase(db, { migrationsFolder })).resolves.toBeUndefined();
    expect((await db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`)).rows).toEqual(history);
  }, 30_000);
});

describe.skipIf(!connection)("resource snapshot JSON migration", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "eval-resource-json-upgrade-"));
    await cp(migrationsFolder, directory, { recursive: true });
    const journalPath = path.join(directory, "meta/_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 4);
    await writeFile(journalPath, JSON.stringify(journal));
    // Only fixture setup stops at the historical prefix; the upgrade uses the production guard.
    database = await createTestDatabase(connection!, (db) => migrate(db, { migrationsFolder: directory }));
  }, 30_000);

  afterAll(async () => {
    if (database) await database.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it("upgrades historical jsonb resources without losing data or migration history", async () => {
    const { db } = database;
    const columnTypes = async () => (await db.execute(sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'eval_attempt_resources'
        AND column_name IN ('snapshot', 'metric_snapshot') ORDER BY column_name
    `)).rows;
    expect(await columnTypes()).toEqual([
      { column_name: "metric_snapshot", data_type: "jsonb" },
      { column_name: "snapshot", data_type: "jsonb" },
    ]);
    expect((await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'eval_resource_sources', 'eval_agent_import_tasks', 'eval_agent_import_intents',
        'eval_agent_import_task_intents', 'eval_agent_import_leases'
      )
    `)).rows).toEqual([]);

    const owner = "resource-json-upgrade-test";
    const seeded = await seedProject(db, owner, { datasets: [{ data: [makeData()] }], evaluation: true });
    const store = createPostgresRuntimeStore(db, owner, release, { enqueue: async () => {} });
    const command = await buildCommand(createPostgresProjectPlanReader(db, owner), store, { projectId: seeded.projectId, operation: "pipeline" });
    await store.admitRun(command);
    const records = [["execution", command.run.samplingIds[0]!], ["evaluation", command.run.evaluationIds[0]!]] as const;
    const saveSnapshot = async (stage: "execution" | "evaluation", recordId: string, attemptId: string, body: string) => {
      const snapshot: AgentResourceSnapshot = {
        scope: { chatId: recordId, idempotencyKey: attemptId, submissionId: attemptId },
        observedAt: "2026-10-17T00:00:00Z", finalized: true,
        coverage: { usageEvents: "complete", nativeRecords: "complete", billingSettlements: "complete" },
        usageEvents: [], billingSettlements: [],
        nativeRecords: nativeToolBodyPair(recordId, attemptId, body, body),
      };
      const resources = { status: "collected" as const, summary: summarizeResourceSnapshot(snapshot) };
      if (stage === "execution") {
        const original = (await store.getSampling(recordId))!;
        await store.updateSampling({ ...original, execution: { status: "succeeded" }, executionAttempts: [...original.executionAttempts, {
          executionAttemptId: attemptId, samplingId: recordId, attemptNumber: original.executionAttempts.length + 1, status: "completed", resources,
        }] }, original, { attemptId, snapshot });
      } else {
        const original = (await store.getEvaluation(recordId))!;
        await store.updateEvaluation({ ...original, status: { status: "succeeded" }, attempts: [...original.attempts, {
          evaluationAttemptId: attemptId, evaluationId: recordId, attemptNumber: original.attempts.length + 1, status: "completed", resources,
        }] }, original, { attemptId, snapshot });
      }
      return snapshot;
    };
    for (const [stage, recordId] of records) {
      await saveSnapshot(stage, recordId, recordId, "before upgrade \u4e2d\u6587 \ud83e\udd16");
    }
    const snapshots = () => db.select().from(attemptResources).orderBy(attemptResources.stage, attemptResources.recordId, attemptResources.attemptId);
    const history = async () => (await db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`)).rows;
    const before = await snapshots();
    expect(before).toHaveLength(2);
    const source = createPostgresMetricsSource(db, owner);
    const factsBefore = await source.read({ projectId: seeded.projectId });
    const prefix = await history();
    expect(prefix).toHaveLength(5);

    await migrateDatabase(db, { migrationsFolder });

    expect(await columnTypes()).toEqual([
      { column_name: "metric_snapshot", data_type: "json" },
      { column_name: "snapshot", data_type: "json" },
    ]);
    expect(await snapshots()).toEqual(before);
    expect(await source.read({ projectId: seeded.projectId })).toEqual(factsBefore);
    const upgradedHistory = await history();
    expect(upgradedHistory.slice(0, prefix.length)).toEqual(prefix);
    const expectedHistory = JSON.parse(await readFile(path.join(migrationsFolder, "meta/_journal.json"), "utf8"));
    expect(upgradedHistory).toHaveLength(expectedHistory.entries.length);

    const reader = createPostgresResourceSnapshotReader(db, owner);
    const download = async (stage: "execution" | "evaluation", recordId: string, attemptId: string) => {
      const stream = await reader.open(seeded.projectId, stage, recordId, attemptId);
      expect(stream).not.toBeNull();
      return JSON.parse(await new Response(stream!).text());
    };
    for (const row of before) expect(await download(row.stage, row.recordId, row.attemptId)).toEqual(row.snapshot);
    for (const [stage, recordId] of records) {
      const attemptId = `${recordId}:after-upgrade`;
      const snapshot = await saveSnapshot(stage, recordId, attemptId, "Unicode \u4e2d\u6587 \ud83e\udd16; high \ud83e; low \udd16; NUL \u0000");
      const row = (await snapshots()).find((item) => item.attemptId === attemptId);
      expect(row?.snapshot).toEqual(snapshot);
      expect(row?.metricSnapshot).toEqual(await compactResourceSnapshot(snapshot));
      expect(await download(stage, recordId, attemptId)).toEqual(snapshot);
    }

    const beforeRerun = await snapshots();
    expect(beforeRerun.filter((row) => row.attemptId === row.recordId)).toEqual(before);
    await expect(migrateDatabase(db, { migrationsFolder })).resolves.toBeUndefined();
    expect(await snapshots()).toEqual(beforeRerun);
    expect(await history()).toEqual(upgradedHistory);
  }, 30_000);
});
