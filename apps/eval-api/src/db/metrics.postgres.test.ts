import type { EvaluationAgentOutput } from "@eval-platform/eval-contracts";
import { eq, inArray } from "drizzle-orm";
import { Pool, type QueryConfig } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvalDb } from "./client.js";
import { createPostgresMetricsSource, createPostgresProjectComparisonSource } from "./metrics.js";
import { createPostgresProjectPlanReader } from "./project-plans.js";
import { createPostgresRuntimeStore } from "./runtime.js";
import { projects, projectSamples } from "./schema.js";
import { createTestDatabase } from "./test-database.js";
import { buildCommand, makeData, release, seedProject, settle } from "./test-fixtures.js";

const connection = process.env.DATABASE_URL;
const owner = "project-comparison-test";

function output(score: number): EvaluationAgentOutput {
  return {
    status: "succeeded", artifacts: [],
    trajectory: { trajectoryId: "trajectory", source: "evaluator", path: "/trajectory.jsonl" },
    structuredOutput: { path: "/result.json", content: JSON.stringify({ score }) },
  };
}

describe.skipIf(!connection)("PostgreSQL Project comparison source", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => { database = await createTestDatabase(connection!); }, 30_000);
  afterAll(async () => { if (database) await database.destroy(); }, 30_000);

  it("reuses the single-Project facts for fixed samples, current results, Schemas and Run projections", async () => {
    const shared = makeData("frozen shared input");
    const neverRun = makeData("never sampled");
    const store = createPostgresRuntimeStore(database.db, owner, release, { enqueue: async () => {} });
    const plans = createPostgresProjectPlanReader(database.db, owner);
    const ids: string[] = [];
    for (const score of [0, 10]) {
      const seeded = await seedProject(database.db, owner, {
        datasets: [{ data: [shared, neverRun] }, { data: [shared] }], evaluation: true,
      });
      ids.push(seeded.projectId);
      const command = await buildCommand(plans, store, {
        projectId: seeded.projectId, operation: "pipeline",
        projectSampleIds: [seeded.samples.find((sample) => sample.dataId === shared.dataId)!.projectSampleId],
      });
      await store.admitRun(command);
      await settle(store, command.run.samplingIds, "succeeded");
      const evaluation = (await store.getEvaluation(command.run.evaluationIds[0]!))!;
      await store.updateEvaluation({ ...evaluation, output: output(score) }, evaluation);
    }
    const compared = await createPostgresProjectComparisonSource(database.db, owner).read(ids);
    const source = createPostgresMetricsSource(database.db, owner);
    const original = [];
    for (const projectId of ids) original.push(await source.read({ projectId }));
    expect(compared).toEqual(original);
    for (const facts of compared) {
      expect(facts.plan.project.ownerUserId).toBe(owner);
      expect(facts.projectSamples).toHaveLength(2);
      expect(facts.samplings).toHaveLength(1);
      expect(facts.evaluations).toHaveLength(1);
      expect(facts.evaluationOutputSchema).toEqual({ type: "object", properties: { score: { type: "number" } } });
      expect(facts.runs).toHaveLength(1);
      expect(facts.runs[0]?.status).toBe("succeeded");
    }
  });

  it("keeps every Project in the opening snapshot when fixed facts and visibility change between Project reads", async () => {
    const shared = makeData("before snapshot");
    const first = await seedProject(database.db, owner, { datasets: [{ data: [shared] }] });
    const second = await seedProject(database.db, owner, { datasets: [{ data: [shared] }] });
    const ids = [first.projectId, second.projectId];
    const pool = new Pool({ connectionString: database.connectionString, max: 1 });
    const connect = pool.connect.bind(pool);
    let connections = 0;
    let changed = false;
    const statements: string[] = [];
    Object.assign(pool, {
      connect: async () => {
        connections++;
        const client = await connect();
        const query = client.query.bind(client);
        return Object.assign(client, {
          query: async (config: QueryConfig, params: unknown[] = []) => {
            const result = await query(config, params);
            statements.push(config.text);
            if (!changed && config.text.includes(' from "eval_projects" ') && params[0] === first.projectId) {
              changed = true;
              await database.db.transaction(async (transaction) => {
                await transaction.update(projects).set({ name: "after snapshot" }).where(inArray(projects.projectId, ids));
                await transaction.update(projectSamples).set({ data: { ...shared, userPrompt: "after snapshot" } })
                  .where(inArray(projectSamples.projectId, ids));
                await transaction.update(projects).set({ deletedAt: new Date() }).where(eq(projects.projectId, second.projectId));
              });
            }
            return result;
          },
        });
      },
    });
    try {
      const facts = await createPostgresProjectComparisonSource(createEvalDb(pool), owner).read(ids);
      expect(changed).toBe(true);
      expect(connections).toBe(1);
      expect(statements[0]).toBe("begin isolation level repeatable read read only");
      expect(statements.at(-1)).toBe("commit");
      expect(facts.map((value) => value.plan.project.name)).toEqual(["Project", "Project"]);
      expect(facts.map((value) => value.projectSamples[0]?.data)).toEqual([shared, shared]);
    } finally {
      await pool.end();
    }
    const fresh = await createPostgresMetricsSource(database.db, owner).read({ projectId: first.projectId });
    expect(fresh.plan.project.name).toBe("after snapshot");
    expect(fresh.projectSamples[0]?.data.userPrompt).toBe("after snapshot");
    await expect(createPostgresProjectComparisonSource(database.db, owner).read(ids)).rejects.toMatchObject({
      entity: "project", id: second.projectId,
    });
  });

  it("rejects the whole read for an unknown, foreign or soft-deleted Project on either side", async () => {
    const owned = await seedProject(database.db, owner, { datasets: [{ data: [makeData()] }] });
    const foreign = await seedProject(database.db, "other-owner", { datasets: [{ data: [makeData()] }] });
    const deleted = await seedProject(database.db, owner, { datasets: [{ data: [makeData()] }] });
    await database.db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.projectId, deleted.projectId));
    const source = createPostgresProjectComparisonSource(database.db, owner);
    for (const inaccessible of ["unknown", foreign.projectId, deleted.projectId]) {
      for (const ids of [[owned.projectId, inaccessible], [inaccessible, owned.projectId]]) {
        await expect(source.read(ids)).rejects.toMatchObject({
          name: "MetricsEntityNotFoundError", entity: "project", id: inaccessible,
        });
      }
    }
    expect(database.db.$client.idleCount).toBe(database.db.$client.totalCount);
  });
});
