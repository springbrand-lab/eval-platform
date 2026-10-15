import { describe, expect, it, vi } from "vitest";
import type { DatasetSnapshot } from "@eval-platform/eval-dataset";
import { DATA, DATASET, EVALUATOR, PROJECT, SAMPLE, evaluation, sampling } from "../test-support.js";
import { createMetrics, MetricsQueryError, MetricsSourceError } from "./index.js";
import type { MetricsFacts, MetricsSource } from "./model.js";

const OTHER_DATA = { dataId: "10000000-0000-4000-8000-000000000002", userPrompt: "Build an API" };
const UNUSED_DATA = { dataId: "10000000-0000-4000-8000-000000000003", userPrompt: "Build a game" };
const SHARED_DATASET = { datasetId: "20000000-0000-4000-8000-000000000002", name: "Shared tasks" };

function facts(): MetricsFacts {
  const baseSamplings = Array.from({ length: 5 }, (_, index) => sampling(`sampling-${index + 1}`));
  const baseEvaluations = baseSamplings.map((subject, index) => evaluation(`evaluation-${index + 1}`, {
    samplingId: subject.samplingId,
    output: { ...evaluation().output!, score: 60 + index * 10 },
  }));
  return {
    project: PROJECT,
    datasets: [{ dataset: DATASET, data: [DATA, OTHER_DATA, UNUSED_DATA] }, { dataset: SHARED_DATASET, data: [DATA] }],
    samples: [SAMPLE, { sampleId: "sample-shared", data: DATA }, { sampleId: "sample-other", data: OTHER_DATA }],
    samplings: [...baseSamplings, sampling("sampling-shared", { sampleId: "sample-shared" }), sampling("sampling-other", { sampleId: "sample-other" })],
    evaluations: [...baseEvaluations, evaluation("reevaluation-1"), evaluation("reevaluation-2", { evaluator: { ...EVALUATOR, userAgentId: "other-judge" } })],
    runs: [
      { runId: "pipeline-run", projectId: PROJECT.projectId, sourceCommit: "a".repeat(40), samplingIds: baseSamplings.map((subject) => subject.samplingId),
        evaluationIds: baseEvaluations.map((judge) => judge.evaluationId), phases: ["execution", "evaluation"], phase: "evaluation", status: "succeeded" },
      { runId: "execution-run", projectId: PROJECT.projectId, sourceCommit: "a".repeat(40), samplingIds: ["sampling-shared", "sampling-other"],
        evaluationIds: [], phases: ["execution"], phase: "execution", status: "succeeded" },
      { runId: "reevaluation-run-1", projectId: PROJECT.projectId, sourceCommit: "a".repeat(40), samplingIds: ["sampling-1"],
        evaluationIds: ["reevaluation-1"], phases: ["evaluation"], phase: "evaluation", status: "succeeded" },
      { runId: "reevaluation-run-2", projectId: PROJECT.projectId, sourceCommit: "a".repeat(40), samplingIds: ["sampling-1"],
        evaluationIds: ["reevaluation-2"], phases: ["evaluation"], phase: "evaluation", status: "succeeded" },
    ],
  };
}

function metricsFrom(input: MetricsFacts = facts()) {
  const read = vi.fn<MetricsSource["read"]>(async () => input);
  return { metrics: createMetrics({ source: { read } }), read, input };
}

describe("four-level reporting", () => {
  it("aggregates the Project directly, not by adding overlapping Dataset subtotals", async () => {
    const { metrics } = metricsFrom();
    const result = await metrics.getProjectOverview({ projectId: PROJECT.projectId });
    expect(result.counts).toEqual({ datasets: 2, data: 2, samples: 3, samplings: 7, evaluations: 7 });
    expect(result.summary).toMatchObject({ samplingCount: 7, evaluationCount: 7 });
    expect(result.datasets).toHaveLength(2);
    expect(result.datasets.map((item) => item.summary.samplingCount)).toEqual([7, 6]);
    expect(result.runIds).toEqual(["execution-run", "pipeline-run", "reevaluation-run-1", "reevaluation-run-2"]);
    expect(result.project.ownerUserId).toBe(PROJECT.ownerUserId);
    expect(result.datasets[0]!.dataset).not.toHaveProperty("ownerUserId");
  });

  it("shows complete Dataset membership and groups different Samples of the same Data separately", async () => {
    const { metrics } = metricsFrom();
    const result = await metrics.getDatasetOverview({ projectId: PROJECT.projectId, datasetId: DATASET.datasetId });
    expect(result.counts).toEqual({ datasets: 1, data: 3, samples: 3, samplings: 7, evaluations: 7 });
    expect(result.dataIds).toEqual([DATA.dataId, OTHER_DATA.dataId, UNUSED_DATA.dataId]);
    expect(result.samples).toHaveLength(3);
    expect(result.samples.find((item) => item.sampleId === SAMPLE.sampleId)).toMatchObject({ dataId: DATA.dataId, summary: { samplingCount: 5 } });
    expect(result.samples.find((item) => item.sampleId === "sample-shared")).toMatchObject({ dataId: DATA.dataId, summary: { samplingCount: 1 } });
  });

  it("shows all five independent Samplings and their execution outputs at the Sample level", async () => {
    const { metrics } = metricsFrom();
    const result = await metrics.getSampleOverview({ projectId: PROJECT.projectId, sampleId: SAMPLE.sampleId });
    expect(result.sample).toEqual(SAMPLE);
    expect(result.sample.data.initialSession).toEqual(DATA.initialSession);
    expect(result.sample.data.initialMaterials).toEqual(DATA.initialMaterials);
    expect(result.sample.data.category).toBe("frontend");
    expect(result.datasetIds).toEqual([DATASET.datasetId, SHARED_DATASET.datasetId]);
    expect(result.counts).toEqual({ datasets: 2, data: 1, samples: 1, samplings: 5, evaluations: 7 });
    expect(result.samplings).toHaveLength(5);
    expect(result.samplings[0]).toMatchObject({ samplingId: "sampling-1", artifactCount: 1, hasTrajectory: true, summary: { evaluationCount: 3 } });
  });

  it("preserves original Sampling, attempts, artifacts, full trajectory and all judge outputs", async () => {
    const { metrics, input } = metricsFrom();
    const result = await metrics.getSamplingDetail({ projectId: PROJECT.projectId, samplingId: "sampling-1" });
    expect(result.sampling).toEqual(input.samplings[0]);
    expect(result.sampling.executionAttempts[0]!.resources).toBeDefined();
    expect(result.sampling.artifacts).toHaveLength(1);
    expect(result.sampling.trajectory?.source).toBe("subject");
    expect(result.evaluations).toHaveLength(3);
    expect(result.evaluations[0]!.result).toMatchObject({ outputStatus: "succeeded", score: { value: 60 }, trajectory: { source: "evaluator" } });
    expect(result.evaluations[0]!.record.attempts).toHaveLength(1);
    expect(result.evaluations[0]!.resources.collections.collected).toBe(1);
    expect(result.summary.scores).toHaveLength(2);
  });

  it("restricts both Sampling and Evaluation identities to selected Runs without counting execution twice", async () => {
    const { metrics } = metricsFrom();
    const query = { projectId: PROJECT.projectId, runIds: ["pipeline-run", "reevaluation-run-1"] };
    const project = await metrics.getProjectOverview(query);
    expect(project.summary).toMatchObject({ samplingCount: 5, evaluationCount: 6 });
    expect(project.summary.execution.attempts).toBe(5);
    expect(project.summary.evaluation.attempts).toBe(6);
    expect(project.summary.scores).toHaveLength(1);
    const detail = await metrics.getSamplingDetail({ ...query, samplingId: "sampling-1" });
    expect(detail.evaluations.map((item) => item.record.evaluationId)).toEqual(["evaluation-1", "reevaluation-1"]);
    await expect(metrics.getSamplingDetail({ ...query, samplingId: "sampling-other" }))
      .rejects.toMatchObject({ name: "MetricsEntityNotFoundError", entity: "sampling", id: "sampling-other" });
  });

  it("shows only the Run's evaluations for an evaluation-only selection", async () => {
    const { metrics } = metricsFrom();
    const result = await metrics.getSampleOverview({ projectId: PROJECT.projectId, sampleId: SAMPLE.sampleId, runIds: ["reevaluation-run-2"] });
    expect(result.summary).toMatchObject({ samplingCount: 1, evaluationCount: 1 });
    expect(result.summary.scores[0]!.evaluator.userAgentId).toBe("other-judge");
  });

  it("supports a known Sample with no Samplings and a known Dataset with no executed Data", async () => {
    const input: MetricsFacts = { ...facts(), samples: [SAMPLE], samplings: [], evaluations: [], runs: [] };
    const { metrics } = metricsFrom(input);
    const sample = await metrics.getSampleOverview({ projectId: PROJECT.projectId, sampleId: SAMPLE.sampleId });
    expect(sample.counts).toMatchObject({ samples: 1, samplings: 0, evaluations: 0 });
    expect(sample.summary.execution.successRate).toBeNull();
    expect(sample.summary.resources.total.costs.chargedUnits.value).toBeNull();
    const dataset = await metrics.getDatasetOverview({ projectId: PROJECT.projectId, datasetId: DATASET.datasetId });
    expect(dataset.counts).toMatchObject({ data: 3, samples: 0, samplings: 0 });
    expect(dataset.samples).toEqual([]);
    const project = await metrics.getProjectOverview({ projectId: PROJECT.projectId });
    expect(project.counts).toEqual({ datasets: 0, data: 0, samples: 0, samplings: 0, evaluations: 0 });
  });

  it("allows a child projection to omit unrelated Run facts but not mix in another judge", async () => {
    const input = facts();
    const target: MetricsFacts = { ...input, samples: [SAMPLE], samplings: [input.samplings[0]!], evaluations: [input.evaluations[0]!, input.evaluations[5]!, input.evaluations[6]!] };
    const { metrics } = metricsFrom(target);
    const result = await metrics.getSamplingDetail({ projectId: PROJECT.projectId, samplingId: "sampling-1", runIds: ["pipeline-run"] });
    expect(result.summary).toMatchObject({ samplingCount: 1, evaluationCount: 1 });
  });

  it("uses one consistent source read and detaches queries, source facts and returned nested objects", async () => {
    const input = facts();
    const before = structuredClone(input);
    const query = { projectId: PROJECT.projectId, samplingId: "sampling-1", runIds: ["pipeline-run"] };
    const read = vi.fn<MetricsSource["read"]>(async (received) => {
      Object.assign(received, { projectId: "source-mutated" });
      return input;
    });
    const result = await createMetrics({ source: { read } }).getSamplingDetail(query);
    expect(read).toHaveBeenCalledTimes(1);
    expect(query).toEqual({ projectId: PROJECT.projectId, samplingId: "sampling-1", runIds: ["pipeline-run"] });
    Object.assign(result.project, { name: "changed" });
    Object.assign(result.sample.data.initialSession!, { sessionId: "changed" });
    Object.assign(result.sampling.artifacts![0]!, { path: "/changed" });
    Object.assign(result.evaluations[0]!.record.evaluator, { userAgentId: "changed" });
    expect(input).toEqual(before);
  });

  it.each([
    null, [], { projectId: "" }, { projectId: " project-1" }, { projectId: "project-1", runIds: [] },
    { projectId: "project-1", runIds: "pipeline-run" }, { projectId: "project-1", runIds: ["pipeline-run", "pipeline-run"] },
  ])("rejects malformed query before reading the source: %j", async (query) => {
    const { metrics, read } = metricsFrom();
    await expect(metrics.getProjectOverview(query as never)).rejects.toThrow(MetricsQueryError);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not forward unknown query fields as another source selection", async () => {
    const { metrics, read } = metricsFrom();
    await metrics.getProjectOverview({ projectId: PROJECT.projectId, datasetId: "unexpected" } as never);
    expect(read).toHaveBeenCalledWith({ projectId: PROJECT.projectId });
  });

  it("reports unknown targets and unknown Runs as missing entities", async () => {
    const { metrics } = metricsFrom();
    const missing = (entity: string) => ({ name: "MetricsEntityNotFoundError", entity, id: "absent" });
    await expect(metrics.getDatasetOverview({ projectId: PROJECT.projectId, datasetId: "absent" })).rejects.toMatchObject(missing("dataset"));
    await expect(metrics.getSampleOverview({ projectId: PROJECT.projectId, sampleId: "absent" })).rejects.toMatchObject(missing("sample"));
    await expect(metrics.getSamplingDetail({ projectId: PROJECT.projectId, samplingId: "absent" })).rejects.toMatchObject(missing("sampling"));
    await expect(metrics.getProjectOverview({ projectId: PROJECT.projectId, runIds: ["absent"] })).rejects.toMatchObject(missing("run"));
  });

  it.each([
    ["wrong Project", (input: MetricsFacts): MetricsFacts => ({ ...input, project: { ...PROJECT, projectId: "foreign" } })],
    ["foreign Sampling", (input: MetricsFacts): MetricsFacts => ({ ...input, samplings: [{ ...input.samplings[0]!, projectId: "foreign" }] })],
    ["foreign Run", (input: MetricsFacts): MetricsFacts => ({ ...input, runs: [{ ...input.runs[0]!, projectId: "foreign" }] })],
    ["duplicate Sample", (input: MetricsFacts): MetricsFacts => ({ ...input, samples: [...input.samples, input.samples[0]!] })],
    ["duplicate Dataset", (input: MetricsFacts): MetricsFacts => ({ ...input, datasets: [...input.datasets, input.datasets[0]!] })],
    ["duplicate Sampling", (input: MetricsFacts): MetricsFacts => ({ ...input, samplings: [...input.samplings, input.samplings[0]!] })],
    ["duplicate Evaluation", (input: MetricsFacts): MetricsFacts => ({ ...input, evaluations: [...input.evaluations, input.evaluations[0]!] })],
    ["duplicate Run", (input: MetricsFacts): MetricsFacts => ({ ...input, runs: [...input.runs, input.runs[0]!] })],
    ["orphan Sampling", (input: MetricsFacts): MetricsFacts => ({ ...input, samplings: [{ ...input.samplings[0]!, sampleId: "absent" }] })],
    ["orphan Evaluation", (input: MetricsFacts): MetricsFacts => ({ ...input, evaluations: [{ ...input.evaluations[0]!, samplingId: "absent" }] })],
    ["duplicate Dataset Data", (input: MetricsFacts): MetricsFacts => ({ ...input, datasets: [{ dataset: DATASET, data: [DATA, DATA] }] })],
  ] as const)("rejects inconsistent source facts: %s", async (_label, change) => {
    const { metrics } = metricsFrom(change(facts()));
    await expect(metrics.getProjectOverview({ projectId: PROJECT.projectId })).rejects.toThrow(MetricsSourceError);
  });

  it("rejects missing required facts for a whole-Run projection", async () => {
    const input = facts();
    const { metrics } = metricsFrom({ ...input, evaluations: input.evaluations.slice(1) });
    await expect(metrics.getProjectOverview({ projectId: PROJECT.projectId, runIds: ["pipeline-run"] }))
      .rejects.toThrow("omitted required facts");
  });

  it("rejects duplicate Run scope identities and an evaluation linked outside its Run", async () => {
    const input = facts();
    const duplicate = metricsFrom({ ...input, runs: [{ ...input.runs[0]!, samplingIds: ["sampling-1", "sampling-1"] }] });
    await expect(duplicate.metrics.getProjectOverview({ projectId: PROJECT.projectId, runIds: ["pipeline-run"] })).rejects.toThrow("duplicate scope");
    const outside = metricsFrom({ ...input, runs: [{ ...input.runs[0]!, samplingIds: ["sampling-2"], evaluationIds: ["evaluation-1"] }] });
    await expect(outside.metrics.getProjectOverview({ projectId: PROJECT.projectId, runIds: ["pipeline-run"] })).rejects.toThrow("outside Run");
  });

  it("propagates source failures without returning an empty successful view", async () => {
    const error = new Error("Read transaction failed");
    const metrics = createMetrics({ source: { async read() { throw error; } } });
    await expect(metrics.getProjectOverview({ projectId: PROJECT.projectId })).rejects.toBe(error);
  });

  it("uses current global Dataset membership rather than inventing Dataset ownership or versions", async () => {
    const input = facts();
    const datasets: DatasetSnapshot[] = [{ dataset: DATASET, data: [OTHER_DATA] }, { dataset: SHARED_DATASET, data: [DATA] }];
    const { metrics } = metricsFrom({ ...input, datasets });
    const dataset = await metrics.getDatasetOverview({ projectId: PROJECT.projectId, datasetId: DATASET.datasetId });
    expect(dataset.summary.samplingCount).toBe(1);
    const sample = await metrics.getSampleOverview({ projectId: PROJECT.projectId, sampleId: SAMPLE.sampleId });
    expect(sample.datasetIds).toEqual([SHARED_DATASET.datasetId]);
  });
});
