import type { EvaluationAgentOutput } from "@eval-platform/eval-contracts";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProjectResultsExport } from "../projects/evaluation-results.js";
import { createPostgresProjectPlanReader } from "./project-plans.js";
import { createPostgresProjectResultsSource } from "./project-results.js";
import { createPostgresRuntimeStore } from "./runtime.js";
import { evaluationOutputSchemas, evaluations, projectDatasets, projects, projectSamples, runs, samplings } from "./schema.js";
import { createTestDatabase } from "./test-database.js";
import { buildCommand, makeData, release, seedProject, settle } from "./test-fixtures.js";

const connection = process.env.DATABASE_URL;
const owner = "project-results-export-test";

function output(content?: string): EvaluationAgentOutput {
  return {
    status: "failed", artifacts: [],
    trajectory: { trajectoryId: "trajectory", source: "evaluator", path: "/trajectory.jsonl" },
    ...(content === undefined ? {} : { structuredOutput: { path: "/result.json", content, contentHash: "raw-hash", source: "result-file" } }),
  };
}

async function unzip(body: ReadableStream<Uint8Array>) {
  const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(await new Response(body).arrayBuffer())), { useWebWorkers: false });
  try {
    const files = new Map<string, Uint8Array>();
    for (const entry of await zip.getEntries()) {
      if (!entry.directory) files.set(entry.filename, await entry.getData!(new Uint8ArrayWriter()));
    }
    return files;
  } finally {
    await zip.close();
  }
}

function json(files: Map<string, Uint8Array>, path: string) {
  return JSON.parse(new TextDecoder().decode(files.get(path)));
}

describe.skipIf(!connection)("PostgreSQL Project evaluation-results export", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => { database = await createTestDatabase(connection!); }, 30_000);
  afterAll(async () => { if (database) await database.destroy(); }, 30_000);

  function exporter(user = owner) {
    return createProjectResultsExport(createPostgresProjectResultsSource(database.db, user));
  }

  it("exports all retained raw outputs under shared frozen Dataset membership, including a soft-deleted Schema, with no persisted changes", async () => {
    const shared = makeData("frozen shared prompt");
    const untouched = makeData("never sampled");
    const seeded = await seedProject(database.db, owner, {
      datasets: [{ data: [shared, untouched] }, { data: [shared] }], samplingCount: 7, evaluation: true,
    });
    const sample = seeded.samples.find((value) => value.dataId === shared.dataId)!;
    const store = createPostgresRuntimeStore(database.db, owner, release, { enqueue: async () => {} });
    const command = await buildCommand(createPostgresProjectPlanReader(database.db, owner), store, {
      projectId: seeded.projectId, operation: "pipeline", projectSampleIds: [sample.projectSampleId],
    });
    await store.admitRun(command);
    const raw = ["{malformed]\r\n", '\uFEFF \n{"score":"不符合 Schema 🤖"}\t ', "", " \r\n\t　", "null"];
    for (const [index, value] of command.evaluations.entries()) {
      if (index === 6) continue;
      const original = (await store.getEvaluation(value.evaluationId))!;
      await store.updateEvaluation({
        ...original, status: { status: "failed", lastError: "saved failure" },
        output: output(raw[index]),
      }, original);
    }
    await database.db.update(projectDatasets).set({ name: "../duplicate name" }).where(eq(projectDatasets.projectId, seeded.projectId));
    const fixed = (await createPostgresProjectPlanReader(database.db, owner).getProjectPlan(seeded.projectId))!;
    const boundSchema = fixed.evaluation!.plan.outputSchema;
    await database.db.update(evaluationOutputSchemas).set({ deletedAt: new Date() })
      .where(eq(evaluationOutputSchemas.outputSchemaId, boundSchema.outputSchemaId));
    const before = {
      samplings: await database.db.select().from(samplings).where(eq(samplings.projectId, seeded.projectId)),
      evaluations: await database.db.select().from(evaluations).where(eq(evaluations.ownerUserId, owner)),
      runs: await database.db.select().from(runs).where(eq(runs.projectId, seeded.projectId)),
    };
    const files = await unzip(await exporter().open(seeded.projectId, new AbortController().signal));
    const root = `project-${encodeURIComponent(seeded.projectId)}`;
    expect(json(files, `${root}/project.json`)).toMatchObject({ project: fixed.project });
    expect(json(files, `${root}/project.json`).execution.subjectAgentConfig).not.toHaveProperty("body");
    expect(json(files, `${root}/project.json`).evaluation.plan.evaluatorAgentConfig).not.toHaveProperty("body");
    expect(json(files, `${root}/evaluation-output.schema.json`)).toEqual({ type: "object", properties: { score: { type: "number" } } });
    for (const dataset of fixed.datasets) {
      const path = `${root}/dataset-${encodeURIComponent(dataset.datasetId)}`;
      expect(json(files, `${path}/dataset.json`)).toEqual(dataset);
      const samplePath = `${path}/sample-${encodeURIComponent(sample.projectSampleId)}`;
      expect(json(files, `${samplePath}/sample.json`)).toEqual(sample);
      for (const [index, record] of command.evaluations.entries()) {
        const samplingPath = `${samplePath}/sampling-${encodeURIComponent(record.samplingId)}`;
        const metadata = json(files, `${samplingPath}/evaluation-${encodeURIComponent(record.evaluationId)}.json`);
        const result = `${samplingPath}/result-${encodeURIComponent(record.evaluationId)}.json`;
        if (index < raw.length) {
          expect(files.get(result)).toEqual(new TextEncoder().encode(raw[index]));
          expect(metadata.output.structuredOutput).toEqual({ path: "/result.json", contentHash: "raw-hash", source: "result-file" });
        } else {
          expect(files.has(result)).toBe(false);
          expect(metadata.status.status).toBe(index === 6 ? "queued" : "failed");
        }
      }
    }
    const neverSampled = seeded.samples.find((value) => value.dataId === untouched.dataId)!;
    const unrunPath = `${root}/dataset-${seeded.datasets[0]!.datasetId}/sample-${encodeURIComponent(neverSampled.projectSampleId)}`;
    expect(json(files, `${unrunPath}/sample.json`)).toEqual(neverSampled);
    expect([...files.keys()].some((path) => path.startsWith(`${unrunPath}/sampling-`))).toBe(false);
    expect(await database.db.select().from(samplings).where(eq(samplings.projectId, seeded.projectId))).toEqual(before.samplings);
    expect(await database.db.select().from(evaluations).where(eq(evaluations.ownerUserId, owner))).toEqual(before.evaluations);
    expect(await database.db.select().from(runs).where(eq(runs.projectId, seeded.projectId))).toEqual(before.runs);
    expect(database.db.$client.idleCount).toBe(database.db.$client.totalCount);
  });

  it("keeps the opening snapshot while an active Run's results, fixed metadata and Project visibility change", async () => {
    const data = makeData("before snapshot");
    const seeded = await seedProject(database.db, owner, { datasets: [{ data: [data] }], samplingCount: 2, evaluation: true });
    const store = createPostgresRuntimeStore(database.db, owner, release, { enqueue: async () => {} });
    const command = await buildCommand(createPostgresProjectPlanReader(database.db, owner), store, { projectId: seeded.projectId, operation: "pipeline" });
    await store.admitRun(command);
    const original = (await store.getEvaluation(command.evaluations[0]!.evaluationId))!;
    await store.updateEvaluation({ ...original, output: output(" \n before \t") }, original);
    const body = await exporter().open(seeded.projectId, new AbortController().signal);
    const updated = (await store.getEvaluation(original.evaluationId))!;
    await store.updateEvaluation({ ...updated, output: output("after") }, updated);
    await database.db.update(projectDatasets).set({ name: "after" }).where(eq(projectDatasets.projectId, seeded.projectId));
    await database.db.update(projectSamples).set({ data: { ...data, userPrompt: "after" } }).where(eq(projectSamples.projectId, seeded.projectId));
    await database.db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.projectId, seeded.projectId));
    const files = await unzip(body);
    const root = `project-${seeded.projectId}/dataset-${seeded.datasets[0]!.datasetId}`;
    expect(json(files, `${root}/dataset.json`).name).toBe("Dataset 0");
    const sample = seeded.samples[0]!;
    const path = `${root}/sample-${encodeURIComponent(sample.projectSampleId)}`;
    expect(json(files, `${path}/sample.json`).data).toEqual(data);
    expect(files.get(`${path}/sampling-${original.samplingId}/result-${original.evaluationId}.json`)).toEqual(new TextEncoder().encode(" \n before \t"));
    await expect(exporter().open(seeded.projectId, new AbortController().signal)).rejects.toMatchObject({
      entity: "project", id: seeded.projectId,
    });
    expect(database.db.$client.idleCount).toBe(database.db.$client.totalCount);
  });

  it("rejects unknown, foreign and soft-deleted Projects before a body, and releases unread or aborted downloads", async () => {
    const seeded = await seedProject(database.db, owner, { datasets: [{ data: [] }] });
    await expect(exporter().open("unknown", new AbortController().signal)).rejects.toMatchObject({ entity: "project" });
    await expect(exporter("other-owner").open(seeded.projectId, new AbortController().signal)).rejects.toMatchObject({ entity: "project" });
    const body = await exporter().open(seeded.projectId, new AbortController().signal);
    await body.cancel();
    expect(database.db.$client.idleCount).toBe(database.db.$client.totalCount);
    const request = new AbortController();
    const aborted = await exporter().open(seeded.projectId, request.signal);
    request.abort();
    await expect(new Response(aborted).arrayBuffer()).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(database.db.$client.idleCount).toBe(database.db.$client.totalCount));
    await database.db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.projectId, seeded.projectId));
    await expect(exporter().open(seeded.projectId, new AbortController().signal)).rejects.toMatchObject({ entity: "project" });
    expect(database.db.$client.idleCount).toBe(database.db.$client.totalCount);
  });

  it("exports retained records from older Runs and never reconstructs replaced records", async () => {
    const first = makeData("first");
    const second = makeData("second");
    const seeded = await seedProject(database.db, owner, { datasets: [{ data: [first, second] }], evaluation: true });
    const plans = createPostgresProjectPlanReader(database.db, owner);
    const store = createPostgresRuntimeStore(database.db, owner, release, { enqueue: async () => {} });
    const original = await buildCommand(plans, store, { projectId: seeded.projectId, operation: "pipeline" });
    await store.admitRun(original);
    for (const value of original.evaluations) {
      const saved = (await store.getEvaluation(value.evaluationId))!;
      await store.updateEvaluation({ ...saved, output: output(value.evaluationId) }, saved);
    }
    await settle(store, original.run.samplingIds, "succeeded");
    const replacedSampleId = seeded.samples.find((sample) => sample.dataId === first.dataId)!.projectSampleId;
    const replaced = original.samplings.find((sampling) => sampling.projectSampleId === replacedSampleId)!;
    const retained = original.samplings.find((sampling) => sampling.projectSampleId !== replacedSampleId)!;
    const replacement = await buildCommand(plans, store, {
      projectId: seeded.projectId, operation: "pipeline", projectSampleIds: [replacedSampleId],
    });
    await store.admitRun(replacement);
    const files = await unzip(await exporter().open(seeded.projectId, new AbortController().signal));
    const paths = [...files.keys()].join("\n");
    expect(paths).not.toContain(`sampling-${replaced.samplingId}/`);
    expect(paths).toContain(`sampling-${retained.samplingId}/`);
    expect(paths).toContain(`sampling-${replacement.samplings[0]!.samplingId}/`);
    expect(paths.split("\n").filter((path) => path.split("/").at(-1)!.startsWith("result-"))).toHaveLength(1);
    expect(await database.db.select().from(runs).where(eq(runs.projectId, seeded.projectId))).toHaveLength(2);
  });
});
