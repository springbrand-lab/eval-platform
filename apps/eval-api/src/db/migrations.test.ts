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
  [1793176731034, "3cab810e0d98f97d930ce9638a9afac0bb4dcd25ce4a49837be8a79f19f1afe8"],
  [1793187963783, "7b409f16a0b9fb06a4072ce7389a46c15e879402a02b7f8b305d7775e9f494ea"],
  [1793264185720, "98696eba43c3b40ccf31391b2f990a23bce25878c7f3daa9e2691b8434a662c9"],
  [1793285187605, "588676807bb0b38f0c95db2b9270da6c970eac2d18a1537a13eec70368d0fcd2"],
];

async function metadata(name: string) {
  return JSON.parse(await readFile(path.join(migrationsFolder, "meta", name), "utf8"));
}

describe("offline Dashboard and management migration integrity", () => {
  it("preserves the immutable Dashboard history and appends management after it", async () => {
    const migrations = readMigrationFiles({ migrationsFolder });
    expect(migrations.slice(0, appliedPrefix.length).map((migration) => [migration.folderMillis, migration.hash])).toEqual(appliedPrefix);
    expect(migrations).toHaveLength(appliedPrefix.length + 1);
    const journal = await metadata("_journal.json");
    expect(journal.entries).toHaveLength(migrations.length);
    expect(journal.entries[8]).toMatchObject({ idx: 8, tag: "0008_dashboard_data_selection", breakpoints: true });
    expect(journal.entries[9]).toMatchObject({ idx: 9, tag: "0009_management_preparation", breakpoints: true });
    expect(journal.entries[10]).toMatchObject({ idx: 10, tag: "0010_management_output_schema", breakpoints: true });
    expect(journal.entries.at(-1)).toMatchObject({ idx: 11, tag: "0011_dataset_member_order", breakpoints: true });
    expect(journal.entries.map((entry: { when: number }) => entry.when)).toEqual(migrations.map((migration) => migration.folderMillis));
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
    for (const migration of readMigrationFiles({ migrationsFolder }).slice(8)) {
      expect(migration.sql.filter((statement) => /\$\d+/u.test(statement))).toEqual([]);
    }
  });

  it("adds only an initially empty exclusion set without changing existing facts or migration history", async () => {
    const previous = await metadata("0007_snapshot.json");
    const current = await metadata("0008_snapshot.json");
    expect(current.prevId).toBe(previous.id);
    const { excluded_data_ids: added, ...columns } = current.tables["public.eval_dashboards"].columns;
    expect(added).toMatchObject({ type: "text[]", notNull: true, default: "'{}'::text[]" });
    expect(columns).toEqual(previous.tables["public.eval_dashboards"].columns);
    for (const [name, table] of Object.entries(previous.tables)) {
      if (name !== "public.eval_dashboards") expect(current.tables[name]).toEqual(table);
    }
    expect(readMigrationFiles({ migrationsFolder })[8]?.sql.join(" ")).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/iu);
  });

  it("appends only the two management tables after Dashboard selection", async () => {
    const previous = await metadata("0008_snapshot.json");
    const current = await metadata("0009_snapshot.json");
    expect(current.prevId).toBe(previous.id);
    const added = Object.keys(current.tables).filter((key) => !(key in previous.tables));
    expect(added.sort()).toEqual(["public.eval_management_operations", "public.eval_management_uploads"]);
    expect(Object.fromEntries(Object.entries(current.tables).filter(([key]) => !added.includes(key)))).toEqual(previous.tables);
    expect(current.tables["public.eval_management_operations"].compositePrimaryKeys)
      .toHaveProperty("eval_management_operations_pk");
    expect(current.tables["public.eval_management_uploads"].indexes)
      .toHaveProperty("eval_management_uploads_expiry_idx");
    expect(readMigrationFiles({ migrationsFolder })[9]?.sql.join(" ")).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/iu);
  });

  it("changes only the management operation kind check, preserving catalog duplicates and existing identity", async () => {
    const previous = await metadata("0009_snapshot.json");
    const current = await metadata("0010_snapshot.json");
    expect(current.prevId).toBe(previous.id);
    expect(Object.keys(current.tables)).toEqual(Object.keys(previous.tables));
    expect(current.tables["public.eval_evaluation_output_schemas"])
      .toEqual(previous.tables["public.eval_evaluation_output_schemas"]);
    for (const [name, table] of Object.entries(previous.tables)) {
      if (name !== "public.eval_management_operations") {
        expect(current.tables[name]).toEqual(table);
      }
    }
    const operations = current.tables["public.eval_management_operations"];
    const old = previous.tables["public.eval_management_operations"];
    expect(operations.columns).toEqual(old.columns);
    expect(operations.indexes).toEqual(old.indexes);
    expect(operations.checkConstraints.eval_management_operations_identity_ck)
      .toEqual(old.checkConstraints.eval_management_operations_identity_ck);
    expect({ ...operations, checkConstraints: old.checkConstraints }).toEqual(old);
    expect(operations.checkConstraints.eval_management_operations_kind_ck.value).toContain("output_schema");
    const statements = readMigrationFiles({ migrationsFolder })[10]!.sql;
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('DROP CONSTRAINT "eval_management_operations_kind_ck"');
    expect(statements[1]).toContain('ADD CONSTRAINT "eval_management_operations_kind_ck"');
    expect(statements.join(" ")).not.toMatch(/\b(INSERT|DELETE|TRUNCATE|INDEX|COLUMN|CREATE TABLE)\b/iu);
  });

  it("appends only nullable Dataset membership positions and their per-Dataset constraints", async () => {
    const previous = await metadata("0010_snapshot.json");
    const current = await metadata("0011_snapshot.json");
    expect(current.prevId).toBe(previous.id);
    expect(Object.keys(current.tables)).toEqual(Object.keys(previous.tables));
    for (const [name, table] of Object.entries(previous.tables)) {
      if (name !== "public.eval_dataset_data") expect(current.tables[name]).toEqual(table);
    }
    const before = previous.tables["public.eval_dataset_data"];
    const after = current.tables["public.eval_dataset_data"];
    const { position, ...columns } = after.columns;
    expect(position).toMatchObject({ type: "integer", notNull: false });
    expect(columns).toEqual(before.columns);
    expect(after.indexes.eval_dataset_data_position_uq).toMatchObject({
      columns: [{ expression: "dataset_id" }, { expression: "position" }], isUnique: true,
    });
    expect(after.checkConstraints.eval_dataset_data_position_ck.value).toContain(">= 0");
    expect({ ...after, columns: before.columns, indexes: before.indexes, checkConstraints: before.checkConstraints })
      .toEqual(before);
    const statements = readMigrationFiles({ migrationsFolder })[11]!.sql.join(" ");
    expect(statements).toMatch(/ADD COLUMN "position" integer/iu);
    expect(statements).toMatch(/UNIQUE INDEX "eval_dataset_data_position_uq"/iu);
    expect(statements).not.toMatch(/\b(UPDATE|INSERT|DELETE|TRUNCATE|DROP)\b/iu);
  });
});
