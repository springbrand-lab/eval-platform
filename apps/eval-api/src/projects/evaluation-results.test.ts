import type { EvaluationAgentOutput, EvaluationRecord, ProjectPlan, Sampling } from "@eval-platform/eval-contracts";
import { RuntimeEntityNotFoundError, type ProjectSample } from "@eval-platform/eval-runtime";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { describe, expect, it, vi } from "vitest";
import { createProjectResultsExport, type ProjectResultsRecord, type ProjectResultsSnapshot } from "./evaluation-results.js";

const projectId = '../项目\\ "?.%';
const sampleId = "../shared\\中文%";
const samplingId = "../sampling\\%";
const datasetIds = ["../dataset\\%", "%2Fdataset"];
const root = `project-${encodeURIComponent(projectId)}`;
const schema = { type: "object", properties: { score: { type: "number" } } };

function plan(): ProjectPlan {
  const harness = { kind: "sp", framework: "sp", agentConfig: { ownerUserId: "owner", userAgentId: "frozen" } } as const;
  return {
    project: { projectId, ownerUserId: "owner", name: "../同名", sourceBranch: "release", createdAt: "2026-01-01T00:00:00.000Z" },
    datasets: datasetIds.map((datasetId) => ({ datasetId, name: "../同名", kind: "general", projectSampleIds: [sampleId] })),
    execution: {
      harness,
      subjectAgentConfig: { sourceUserAgentId: "source-subject", name: "执行 Agent", body: { secret: "agent-private-secret" } },
      executionConcurrency: 2,
      retryPolicy: { maxRestarts: 1, initialBackoffMs: 250, maxBackoffMs: 10_000 },
    },
    executionPlanDigest: "execution-digest",
    evaluation: {
      plan: {
        evaluationHarness: harness,
        evaluatorAgentConfig: { sourceUserAgentId: "source-evaluator", name: "评估 Agent", body: { credential: "result-submission-secret" } },
        evaluationConcurrency: 2,
        retryPolicy: { maxRestarts: 1, initialBackoffMs: 250, maxBackoffMs: 10_000 },
        outputSchema: { outputSchemaId: "schema", digest: "schema-digest" },
      },
      digest: "evaluation-digest",
      lockedAt: "2026-01-02T00:00:00.000Z",
    },
  };
}

function sample(projectSampleId = sampleId): ProjectSample {
  return {
    projectSampleId, projectId, dataId: "data", datasetIds, samplingCount: 2,
    data: { dataId: "data", name: "../同名", sampleId: { business: "unchanged" }, userPrompt: "原始输入", evalPrompt: "评估输入" },
  };
}

function sampling(id = samplingId, projectSampleId = sampleId): Sampling {
  return {
    samplingId: id, projectId, projectSampleId,
    subjectAgent: { ownerUserId: "owner", userAgentId: "subject" },
    subjectChatId: "subject-chat",
    execution: { status: "succeeded" },
    executionAttempts: [{ executionAttemptId: "attempt", samplingId: id, attemptNumber: 1, status: "completed", submissionId: "submission" }],
    artifacts: [{ artifactId: "artifact", kind: "artifact", path: "/workspace/index.html", contentHash: "artifact-hash" }],
    trajectory: { trajectoryId: "trajectory", source: "subject", path: "/evidence/trajectory.jsonl", contentHash: "trajectory-hash" },
    evidence: { evidenceId: "evidence", manifestSha256: "manifest-hash", exportedAt: "2026-01-01T00:00:00.000Z" },
  };
}

function output(content?: string): EvaluationAgentOutput {
  return {
    status: "failed", artifacts: [],
    trajectory: { trajectoryId: "evaluation-trajectory", source: "evaluator", path: "/trajectory" },
    ...(content === undefined ? {} : { structuredOutput: {
      path: "/result.json", content, contentHash: "raw-hash", source: "submission",
    } }),
    error: "original error",
  };
}

function evaluation(evaluationId: string, content?: string): EvaluationRecord {
  return {
    evaluationId, samplingId,
    evaluator: { ownerUserId: "owner", userAgentId: "evaluator" },
    chatId: "evaluator-chat",
    status: { status: "failed", lastError: "invalid result" },
    attempts: [{ evaluationAttemptId: "evaluation-attempt", evaluationId, attemptNumber: 1, status: "completed" }],
    output: output(content),
    scoreSync: { status: "failed", at: "2026-01-01T00:00:00.000Z", lastError: "not validated" },
  };
}

async function* items<T>(values: readonly T[]): AsyncIterable<T> {
  yield* values;
}

function snapshot(overrides: Partial<ProjectResultsSnapshot> = {}) {
  return {
    plan: plan(), outputSchema: schema,
    samples: items([sample()]),
    records: items<ProjectResultsRecord>([]),
    close: vi.fn(async (_failed?: boolean) => {}),
    ...overrides,
  };
}

async function unzip(body: ReadableStream<Uint8Array>): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  const zip = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
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

function json(files: Map<string, Uint8Array>, name: string): unknown {
  return JSON.parse(new TextDecoder().decode(files.get(name)));
}

async function brokenArchive(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let failure: unknown;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } catch (error) {
    failure = error;
  } finally {
    reader.releaseLock();
  }
  expect(failure).toBeInstanceOf(Error);
  const partial = Buffer.concat(chunks);
  const zip = new ZipReader(new Uint8ArrayReader(partial), { useWebWorkers: false });
  try {
    await expect(zip.getEntries()).rejects.toThrow();
  } finally {
    await zip.close();
  }
  return failure;
}

describe("Project evaluation-results ZIP export", () => {
  it("exports frozen identity paths, shared samples and exact raw result bytes without private bodies or duplicated result content", async () => {
    const raw = [
      ["../result\\%\"中文", "{not JSON]\n"],
      ["%2Fresult", "\uFEFF \t{\n\"score\":4, \"text\":\"中文🤖\"}\r\n "],
      ["empty", ""],
      ["whitespace", " \r\n\t　"],
      ["null", "null"],
      ["incompatible", '["not an object"]'],
    ] as const;
    const records = raw.map(([id, content]) => ({ sampling: sampling(), evaluation: evaluation(id, content) }));
    const pending: EvaluationRecord = {
      evaluationId: "pending", samplingId, evaluator: { ownerUserId: "owner", userAgentId: "evaluator" },
      status: { status: "running" }, attempts: [],
    };
    records.push({ sampling: sampling(), evaluation: evaluation("missing") }, { sampling: sampling(), evaluation: pending });
    const secondId = "%2Fsample";
    const original = plan();
    const fixed = {
      ...original,
      datasets: original.datasets.map((dataset, index) => index === 0 ? { ...dataset, projectSampleIds: [sampleId, secondId] } : dataset),
    };
    const second = { ...sample(secondId), datasetIds: [datasetIds[0]!] };
    const snap = snapshot({
      plan: fixed, samples: items([sample(), second]),
      records: items([...records, { sampling: sampling("%2Fsampling", secondId), evaluation: null }]),
    });
    const source = vi.fn(async (_projectId: string, _signal: AbortSignal) => snap);
    const files = await unzip(await createProjectResultsExport(source).open(projectId, new AbortController().signal));
    expect(source).toHaveBeenCalledWith(projectId, expect.any(AbortSignal));
    expect(snap.close).toHaveBeenCalledExactlyOnceWith();
    expect(json(files, `${root}/project.json`)).toMatchObject({
      project: fixed.project,
      execution: { subjectAgentConfig: { sourceUserAgentId: "source-subject", name: "执行 Agent" } },
      evaluation: { plan: { evaluatorAgentConfig: { sourceUserAgentId: "source-evaluator", name: "评估 Agent" } } },
    });
    expect(json(files, `${root}/evaluation-output.schema.json`)).toEqual(schema);
    const expected = [`${root}/project.json`, `${root}/evaluation-output.schema.json`];
    for (const dataset of fixed.datasets) {
      const directory = `${root}/dataset-${encodeURIComponent(dataset.datasetId)}`;
      expected.push(`${directory}/dataset.json`);
      expect(json(files, `${directory}/dataset.json`)).toEqual(dataset);
      const path = `${directory}/sample-${encodeURIComponent(sampleId)}`;
      expected.push(`${path}/sample.json`);
      expect(json(files, `${path}/sample.json`)).toEqual(sample());
      const samplingPath = `${path}/sampling-${encodeURIComponent(samplingId)}`;
      expected.push(`${samplingPath}/sampling.json`);
      expect(json(files, `${samplingPath}/sampling.json`)).toEqual(sampling());
      for (const [id, content] of raw) {
        const encoded = encodeURIComponent(id);
        expected.push(`${samplingPath}/evaluation-${encoded}.json`, `${samplingPath}/result-${encoded}.json`);
        expect(files.get(`${samplingPath}/result-${encoded}.json`)).toEqual(new TextEncoder().encode(content));
        const metadata = json(files, `${samplingPath}/evaluation-${encoded}.json`);
        expect(metadata).toMatchObject({
          evaluationId: id, samplingId, status: { status: "failed" },
          output: { structuredOutput: { path: "/result.json", contentHash: "raw-hash", source: "submission" } },
        });
        expect((metadata as EvaluationRecord).output!.structuredOutput).not.toHaveProperty("content");
      }
      for (const id of ["missing", "pending"]) {
        expected.push(`${samplingPath}/evaluation-${id}.json`);
        expect(files.has(`${samplingPath}/result-${id}.json`)).toBe(false);
      }
      expect(json(files, `${samplingPath}/evaluation-pending.json`)).toEqual(pending);
    }
    const secondPath = `${root}/dataset-${encodeURIComponent(datasetIds[0]!)}/sample-${encodeURIComponent(secondId)}`;
    expected.push(`${secondPath}/sample.json`, `${secondPath}/sampling-%252Fsampling/sampling.json`);
    expect(json(files, `${secondPath}/sample.json`)).toEqual(second);
    expect([...files.keys()].sort()).toEqual(expected.sort());
    for (const path of files.keys()) {
      expect(path.split("/").every((segment) => segment !== "." && segment !== ".." && !segment.includes("\\"))).toBe(true);
    }
    const metadataText = [...files].filter(([name]) => !name.split("/").at(-1)!.startsWith("result-"))
      .map(([, bytes]) => new TextDecoder().decode(bytes)).join("\n");
    expect(metadataText).not.toContain("agent-private-secret");
    expect(metadataText).not.toContain("result-submission-secret");
    expect(snap.plan.execution.subjectAgentConfig.body).toEqual({ secret: "agent-private-secret" });
    expect(records[0]!.evaluation!.output!.structuredOutput!.content).toBe(raw[0][1]);
  });

  it("compresses results with Deflate while preserving their original bytes", async () => {
    const content = `${JSON.stringify({ reason: "重复评估结果 content 中文 ".repeat(20_000) })}\n`;
    const snap = snapshot({
      records: items([{ sampling: sampling(), evaluation: evaluation("compressed", content) }]),
    });
    const body = await createProjectResultsExport(async () => snap).open(projectId, new AbortController().signal);
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const zip = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
    try {
      const path = `${root}/dataset-${encodeURIComponent(datasetIds[0]!)}/sample-${encodeURIComponent(sampleId)}`
        + `/sampling-${encodeURIComponent(samplingId)}/result-compressed.json`;
      const entry = (await zip.getEntries()).find((file) => file.filename === path);
      if (!entry || entry.directory) throw new Error("Compressed result file is missing");
      expect(entry.compressionMethod).toBe(8);
      expect(entry.compressedSize).toBeLessThan(entry.uncompressedSize / 4);
      expect(await entry.getData!(new Uint8ArrayWriter())).toEqual(new TextEncoder().encode(content));
    } finally {
      await zip.close();
    }
  });

  it("retains meaningful Project and Dataset metadata without a plan, Sampling or result", async () => {
    const fixed = { ...plan(), evaluation: null, datasets: [{ datasetId: "empty", name: "空数据集", kind: "general" as const, projectSampleIds: [] }] };
    const snap = snapshot({ plan: fixed, outputSchema: null, samples: items([]) });
    const files = await unzip(await createProjectResultsExport(async () => snap).open(projectId, new AbortController().signal));
    expect([...files.keys()]).toEqual([`${root}/project.json`, `${root}/dataset-empty/dataset.json`]);
    expect(json(files, `${root}/project.json`)).toMatchObject({ project: fixed.project, evaluation: null });
    expect(json(files, `${root}/dataset-empty/dataset.json`)).toEqual(fixed.datasets[0]);
    const empty = snapshot({ plan: { ...fixed, datasets: [] }, outputSchema: null, samples: items([]) });
    expect([...(await unzip(await createProjectResultsExport(async () => empty).open(projectId, new AbortController().signal))).keys()])
      .toEqual([`${root}/project.json`]);
  });

  it("fails before returning a body when the owner-scoped snapshot cannot open", async () => {
    const error = new RuntimeEntityNotFoundError("project", projectId);
    const exporter = createProjectResultsExport(async () => { throw error; });
    await expect(exporter.open(projectId, new AbortController().signal)).rejects.toBe(error);
  });

  it("does not finalize a valid partial archive when a saved record read fails", async () => {
    const failure = new Error("database read failed");
    const snap = snapshot({
      records: (async function* () {
        yield { sampling: sampling(), evaluation: evaluation("saved", "{}") };
        throw failure;
      })(),
    });
    expect(await brokenArchive(await createProjectResultsExport(async () => snap).open(projectId, new AbortController().signal))).toBe(failure);
    await vi.waitFor(() => expect(snap.close).toHaveBeenCalledExactlyOnceWith(true));
  });

  it("does not finalize an archive when finishing the read snapshot fails", async () => {
    const failure = new Error("snapshot commit failed");
    const snap = snapshot({ close: vi.fn(async (failed?: boolean) => { if (!failed) throw failure; }) });
    expect(await brokenArchive(await createProjectResultsExport(async () => snap).open(projectId, new AbortController().signal))).toBe(failure);
    await vi.waitFor(() => expect(snap.close).toHaveBeenLastCalledWith(true));
  });

  it("does not read results ahead of ZIP backpressure and releases on consumer cancellation", async () => {
    const reads = vi.fn();
    const snap = snapshot({
      records: (async function* () {
        for (let index = 0; index < 100; index++) {
          reads();
          yield { sampling: sampling(), evaluation: evaluation(String(index), "x".repeat(2_000_000)) };
        }
      })(),
    });
    const source = vi.fn(async (_projectId: string, _signal: AbortSignal) => snap);
    const body = await createProjectResultsExport(source).open(projectId, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).not.toHaveBeenCalled();
    expect(snap.close).not.toHaveBeenCalled();
    const reader = body.getReader();
    for (;;) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      if (new TextDecoder().decode(next.value).includes("result-0.json")) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toHaveBeenCalledTimes(1);
    await reader.cancel();
    expect(source.mock.calls[0]![1].aborted).toBe(true);
    expect(snap.close).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("releases a snapshot if its acquisition completes after the request has been aborted", async () => {
    const snap = snapshot();
    let resolve!: (snapshot: ProjectResultsSnapshot) => void;
    const source = vi.fn(() => new Promise<ProjectResultsSnapshot>((done) => { resolve = done; }));
    const request = new AbortController();
    const opening = createProjectResultsExport(source).open(projectId, request.signal);
    const failure = new Error("disconnected while opening");
    request.abort(failure);
    resolve(snap);
    await expect(opening).rejects.toBe(failure);
    expect(snap.close).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("aborts an unread backpressured body when the request disconnects", async () => {
    const snap = snapshot();
    const source = vi.fn(async (_projectId: string, _signal: AbortSignal) => snap);
    const request = new AbortController();
    const body = await createProjectResultsExport(source).open(projectId, request.signal);
    const failure = new Error("request disconnected");
    request.abort(failure);
    await expect(new Response(body).arrayBuffer()).rejects.toBe(failure);
    await vi.waitFor(() => expect(snap.close).toHaveBeenCalledExactlyOnceWith(true));
    expect(source.mock.calls[0]![1].aborted).toBe(true);
  });

  it("does not acquire a snapshot for an already-aborted request", async () => {
    const source = vi.fn(async () => snapshot());
    const request = new AbortController();
    request.abort();
    await expect(createProjectResultsExport(source).open(projectId, request.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(source).not.toHaveBeenCalled();
  });
});
