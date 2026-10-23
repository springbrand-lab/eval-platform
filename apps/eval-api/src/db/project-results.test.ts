import type { ProjectPlan } from "@eval-platform/eval-contracts";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalDb } from "./client.js";
import { createPostgresProjectResultsSource } from "./project-results.js";

const reads = vi.hoisted(() => ({
  plan: vi.fn(),
  samples: vi.fn(),
  schema: vi.fn(),
}));

vi.mock("./project-plans.js", () => ({
  readProjectPlan: reads.plan,
  readProjectSamples: reads.samples,
  readEvaluationOutputSchema: reads.schema,
}));

const plan: ProjectPlan = {
  project: { projectId: "project", ownerUserId: "owner", name: "Project", sourceBranch: "release", createdAt: "2026-01-01T00:00:00Z" },
  datasets: [],
  execution: {
    harness: { kind: "sp", framework: "sp", agentConfig: { ownerUserId: "owner", userAgentId: "subject" } },
    subjectAgentConfig: { sourceUserAgentId: "source", name: "执行 Agent", body: {} },
    executionConcurrency: 1, retryPolicy: { maxRestarts: 0, initialBackoffMs: 250, maxBackoffMs: 10_000 },
  },
  executionPlanDigest: "digest",
  evaluation: null,
};

function setup() {
  const client = {
    query: vi.fn(async (_query: unknown, _params?: unknown) => ({ rows: [] as unknown[], rowCount: 0 })),
    release: vi.fn((_destroy?: boolean) => {}),
  };
  const connect = vi.fn(async () => client as unknown as PoolClient);
  const db = { $client: { connect } } as unknown as EvalDb;
  return { client, connect, source: createPostgresProjectResultsSource(db, "owner") };
}

beforeEach(() => {
  vi.clearAllMocks();
  reads.plan.mockResolvedValue(plan);
  reads.samples.mockResolvedValue([]);
  reads.schema.mockResolvedValue(null);
});

describe("PostgreSQL Project results snapshot lifetime", () => {
  it("checks owner-scoped visibility in one repeatable-read read-only snapshot and releases after a successful finish", async () => {
    const { source, client } = setup();
    const snapshot = await source("project", new AbortController().signal);
    expect(client.query).toHaveBeenCalledWith(expect.stringMatching(/^BEGIN ISOLATION LEVEL repeatable read read only$/iu));
    expect(reads.plan).toHaveBeenCalledWith(expect.anything(), "project", "owner");
    expect(reads.schema).toHaveBeenCalledWith(expect.anything(), "project", "owner");
    expect(snapshot.plan).toBe(plan);
    expect(client.release).not.toHaveBeenCalled();
    await snapshot.close();
    await snapshot.close();
    expect(client.query).toHaveBeenLastCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns Project-not-found and rolls back before exposing an inaccessible snapshot", async () => {
    const { source, client } = setup();
    reads.plan.mockResolvedValueOnce(null);
    await expect(source("foreign-or-deleted", new AbortController().signal)).rejects.toMatchObject({
      name: "RuntimeEntityNotFoundError", entity: "project", id: "foreign-or-deleted",
    });
    expect(reads.schema).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("releases after a Schema read failure and preserves the original error", async () => {
    const { source, client } = setup();
    const failure = new Error("Schema digest mismatch");
    reads.schema.mockRejectedValueOnce(failure);
    await expect(source("project", new AbortController().signal)).rejects.toBe(failure);
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("destroys its dedicated connection on request abort, including while ZIP output is backpressured", async () => {
    const { source, client } = setup();
    const request = new AbortController();
    const snapshot = await source("project", request.signal);
    request.abort(new Error("disconnected"));
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    await snapshot.close(true);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rejects an aborted pool acquisition immediately and releases the client if it arrives later", async () => {
    const { source, client, connect } = setup();
    let resolve!: (client: PoolClient) => void;
    connect.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const request = new AbortController();
    const pending = source("project", request.signal);
    const failure = new Error("aborted in pool queue");
    request.abort(failure);
    await expect(pending).rejects.toBe(failure);
    resolve(client as unknown as PoolClient);
    await vi.waitFor(() => expect(client.release).toHaveBeenCalledTimes(1));
    expect(client.query).not.toHaveBeenCalled();
  });

  it("destroys a connection when committing the read snapshot fails", async () => {
    const { source, client } = setup();
    const snapshot = await source("project", new AbortController().signal);
    const failure = new Error("connection failed on commit");
    client.query.mockRejectedValueOnce(failure);
    await expect(snapshot.close()).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("loads frozen sample bodies in bounded pages without repeating shared identities", async () => {
    const { source, client } = setup();
    const ids = Array.from({ length: 70 }, (_, index) => `sample-${index}`);
    reads.plan.mockResolvedValueOnce({
      ...plan,
      datasets: [
        { datasetId: "first", name: "first", kind: "general", projectSampleIds: ids },
        { datasetId: "second", name: "second", kind: "general", projectSampleIds: ids.slice(0, 5) },
      ],
    });
    reads.samples.mockImplementation(async (_reader: unknown, _projectId: string, projectSampleIds: readonly string[]) =>
      projectSampleIds.map((projectSampleId) => ({ projectSampleId })));
    const snapshot = await source("project", new AbortController().signal);
    const seen: string[] = [];
    for await (const sample of snapshot.samples) seen.push(sample.projectSampleId);
    expect(seen).toEqual(ids);
    expect(reads.samples).toHaveBeenCalledTimes(3);
    expect(reads.samples.mock.calls.every((call) => call[2].length <= 32)).toBe(true);
    await snapshot.close();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("reports missing frozen sample rows instead of silently omitting them", async () => {
    const { source } = setup();
    reads.plan.mockResolvedValueOnce({
      ...plan, datasets: [{ datasetId: "dataset", name: "dataset", kind: "general", projectSampleIds: ["missing"] }],
    });
    reads.samples.mockResolvedValueOnce([null]);
    const snapshot = await source("project", new AbortController().signal);
    await expect(snapshot.samples[Symbol.asyncIterator]().next()).rejects.toThrow("missing");
    await snapshot.close(true);
  });

  it("reads joined Sampling/Evaluation records with a one-result cursor bound and never reads raw snapshots", async () => {
    const { source, client } = setup();
    const snapshot = await source("project", new AbortController().signal);
    const samplingFacts = { subjectAgent: { ownerUserId: "owner", userAgentId: "subject" }, execution: { status: "succeeded" }, executionAttempts: [] };
    const evaluationFacts = { evaluator: { ownerUserId: "owner", userAgentId: "evaluator" }, status: { status: "queued" }, attempts: [] };
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    client.query.mockResolvedValueOnce({
      rows: [{
        sampling_id: "sampling", project_id: "project", project_sample_id: "sample", sampling_facts: samplingFacts,
        evaluation_id: "evaluation", evaluation_facts: evaluationFacts,
      }],
      rowCount: 1,
    });
    const first = await snapshot.records[Symbol.asyncIterator]().next();
    expect(first).toMatchObject({
      done: false,
      value: { sampling: { samplingId: "sampling", projectSampleId: "sample" }, evaluation: { evaluationId: "evaluation", status: { status: "queued" } } },
    });
    const query = client.query.mock.calls[1]!;
    expect(query[0]).toEqual(expect.stringContaining('left join "eval_evaluations"'));
    expect(query[0]).toEqual(expect.stringMatching(/^DECLARE project_results NO SCROLL CURSOR FOR /u));
    expect(query[1]).toEqual(expect.arrayContaining(["owner", "project"]));
    expect(client.query).toHaveBeenLastCalledWith("FETCH 1 FROM project_results");
    expect(JSON.stringify(client.query.mock.calls)).not.toContain("eval_attempt_resources");
    await snapshot.close();
  });

  it("retains Samplings without Evaluations and reuses one joined cursor across results", async () => {
    const { source, client } = setup();
    const snapshot = await source("project", new AbortController().signal);
    const samplingFacts = { subjectAgent: { ownerUserId: "owner", userAgentId: "subject" }, execution: { status: "failed" }, executionAttempts: [] };
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    client.query.mockResolvedValueOnce({
      rows: [{ sampling_id: "one", project_id: "project", project_sample_id: "sample", sampling_facts: samplingFacts, evaluation_id: null, evaluation_facts: null }],
      rowCount: 1,
    });
    client.query.mockResolvedValueOnce({
      rows: [{ sampling_id: "two", project_id: "project", project_sample_id: "sample", sampling_facts: samplingFacts, evaluation_id: null, evaluation_facts: null }],
      rowCount: 1,
    });
    const found = [];
    for await (const record of snapshot.records) found.push(record);
    expect(found).toMatchObject([
      { sampling: { samplingId: "one", execution: { status: "failed" } }, evaluation: null },
      { sampling: { samplingId: "two", execution: { status: "failed" } }, evaluation: null },
    ]);
    expect(client.query.mock.calls.filter(([text]) => typeof text === "string" && text.startsWith("DECLARE "))).toHaveLength(1);
    expect(client.query.mock.calls.filter(([text]) => text === "FETCH 1 FROM project_results")).toHaveLength(3);
    await snapshot.close();
  });
});
