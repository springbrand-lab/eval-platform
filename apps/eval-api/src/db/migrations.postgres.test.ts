import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migrations.js";
import { datasets } from "./schema.js";
import { createTestDatabase } from "./test-database.js";

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
