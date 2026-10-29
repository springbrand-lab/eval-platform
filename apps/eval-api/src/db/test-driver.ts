import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { Pool, type QueryConfig } from "pg";
import { vi } from "vitest";
import { createEvalDb } from "./client.js";

export interface TestDriverQuery {
  readonly connection: number;
  readonly text: string;
  readonly params: readonly unknown[];
}

export function driverRow(table: PgTable, record: Readonly<Record<string, unknown>>): unknown[] {
  return Object.keys(getTableColumns(table)).map((key) => {
    const value = record[key];
    return value instanceof Date ? value.toISOString() : value;
  });
}

export function createTestDriver(execute: (query: TestDriverQuery) => readonly unknown[] | Promise<readonly unknown[]>) {
  const queries: TestDriverQuery[] = [];
  const releases: ReturnType<typeof vi.fn>[] = [];
  const connect = vi.fn(async () => {
    const connection = releases.length;
    const release = vi.fn();
    releases.push(release);
    return {
      release,
      query: async (config: string | QueryConfig, params: readonly unknown[] = []) => {
        const query = { connection, text: typeof config === "string" ? config : config.text, params };
        queries.push(query);
        return { rows: await execute(query) };
      },
    };
  });
  const pool = Object.assign(new Pool({ connectionString: "postgres://unused:unused@invalid.test/unused" }), {
    connect,
    query: vi.fn(async () => { throw new Error("The adapter must use its transaction client"); }),
  });
  return { db: createEvalDb(pool), connect, queries, releases };
}
