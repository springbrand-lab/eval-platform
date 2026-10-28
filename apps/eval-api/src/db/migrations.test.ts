import { readFile } from "node:fs/promises";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

const migrationsFolder = path.resolve("migrations-postgres");
const appliedPrefix = [
  [1792051912249, "cbf34756262ed7fc46598166c2b761aa6f31de0bb4faf1f286b7b11a947d33a3"],
  [1792165388750, "e866298f7f5d3c6785a29aa76587c7a350d326faf96b8163423ab1dcde31d6fb"],
  [1792215512673, "0d7403a34eb3def3b2d3994e3412104de032512c0506cc3d312eda20bd2d101c"],
  [1792298194314, "f719737b5410533c25cf34034451c4b82ba96a08d14a2eeed59acf881308386a"],
  [1792419566642, "367b578f6d9bd4095526a2a75a365a6aa2cd6d4739148dbbed8ecac7d23892a3"],
  [1792440426582, "dba1521d998f78ed6739ea7606b922d73b6c58c019a67f3b97114167514c9bf7"],
  [1792517619186, "fbd9e2a5e49739c4d0887eba6c95696f54167a718c3a975525165f96376e3a92"],
];

async function metadata(name: string) {
  return JSON.parse(await readFile(path.join(migrationsFolder, "meta", name), "utf8"));
}

describe("offline Dashboard migration integrity", () => {
  it("preserves the immutable migration history and appends one new migration", async () => {
    const migrations = readMigrationFiles({ migrationsFolder });
    expect(migrations.slice(0, appliedPrefix.length).map((migration) => [migration.folderMillis, migration.hash])).toEqual(appliedPrefix);
    expect(migrations).toHaveLength(appliedPrefix.length + 1);
    const journal = await metadata("_journal.json");
    expect(journal.entries.at(-1)).toMatchObject({ idx: 7, tag: "0007_dashboards", breakpoints: true });
    expect(migrations.at(-1)!.folderMillis).toBeGreaterThan(migrations.at(-2)!.folderMillis);
  });

  it("adds only the two configuration tables and keeps the preceding schema unchanged", async () => {
    const previous = await metadata("0006_snapshot.json");
    const current = await metadata("0007_snapshot.json");
    expect(current.prevId).toBe(previous.id);
    const added = Object.keys(current.tables).filter((key) => !(key in previous.tables));
    expect(added.sort()).toEqual(["public.eval_dashboard_projects", "public.eval_dashboards"]);
    expect(Object.fromEntries(Object.entries(current.tables).filter(([key]) => !added.includes(key)))).toEqual(previous.tables);
    expect(current.tables["public.eval_dashboards"].columns).not.toHaveProperty("project_ids");
    expect(current.tables["public.eval_dashboard_projects"].foreignKeys).toMatchObject({
      eval_dashboard_projects_dashboard_fk: {
        columnsFrom: ["owner_user_id", "dashboard_id"], columnsTo: ["owner_user_id", "dashboard_id"], onDelete: "cascade",
      },
      eval_dashboard_projects_project_fk: {
        columnsFrom: ["owner_user_id", "project_id"], columnsTo: ["owner_user_id", "project_id"], onDelete: "no action",
      },
    });
  });

  it("provides self-contained DDL with no runtime bind parameters", () => {
    const migration = readMigrationFiles({ migrationsFolder }).at(-1)!;
    expect(migration.sql.filter((statement) => /\$\d+/u.test(statement))).toEqual([]);
  });
});
