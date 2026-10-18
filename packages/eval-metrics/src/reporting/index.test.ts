import { describe, expect, it, vi } from "vitest";
import type { EvaluationOutputSchema, EvaluationRecord } from "@eval-platform/eval-contracts";
import type { SamplingSnapshot } from "@eval-platform/eval-runtime";
import {
  collection, dataset, evaluation, facts, OUTPUT_SCHEMA, plan, PROJECT, projectSample, run, sampling, telemetry, usage,
} from "../test-support.js";
import { createMetrics, MetricsEntityNotFoundError, MetricsQueryError, MetricsSourceError } from "./index.js";
import type { MetricSummary } from "../aggregation/model.js";
import type { MetricsFacts, MetricsQuery, MetricsSource } from "./model.js";

const D1 = "dataset-1";
const D2 = "dataset-2";
const PS1 = projectSample("ps-1", [D1, D2], "10000000-0000-4000-8000-000000000001", 2);
const PS2 = projectSample("ps-2", [D1], "10000000-0000-4000-8000-000000000002");
const PS3 = projectSample("ps-3", [D1], "10000000-0000-4000-8000-000000000003");
const PLAN = plan([dataset(D1, ["ps-1", "ps-2", "ps-3"]), dataset(D2, ["ps-1"])]);

function tokens(total: number, eventId: string) {
  return collection({ usageEvents: [usage(eventId, { metrics: { totalTokens: total } })] });
}

function subjectRun(samplingId: string, projectSampleId: string, total: number): SamplingSnapshot {
  const base = sampling(samplingId, { projectSampleId });
  return { ...base, executionAttempts: [{ ...base.executionAttempts[0]!, resources: tokens(total, `usage:${samplingId}`) }] };
}

function judge(evaluationId: string, samplingId: string, score: number, total = 1): EvaluationRecord {
  const base = evaluation(evaluationId, { samplingId }, { score, scores: [{ value: score / 10 }] });
  return { ...base, attempts: [{ ...base.attempts[0]!, resources: tokens(total, `usage:${evaluationId}`) }] };
}

const SAMPLINGS = [subjectRun("s1a", "ps-1", 100), subjectRun("s1b", "ps-1", 200), subjectRun("s2", "ps-2", 400)];
const PIPELINE = run("pipeline-run", { samplingIds: ["s1a", "s1b", "s2"], evaluationIds: ["e1b", "e2"] });
const REEVALUATION = run("reevaluation-run", {
  operation: "evaluation", phases: ["evaluation"], samplingIds: ["s1a"], evaluationIds: ["e1a2"],
  targets: { projectSampleIds: [], samplingIds: ["s1a"] },
});
/** After an evaluation-only Run replaced e1a (score 10) with e1a2 (score 50); the rest is untouched. */
const CURRENT = facts({
  plan: PLAN, projectSamples: [PS1, PS2, PS3], samplings: SAMPLINGS,
  evaluations: [judge("e1a2", "s1a", 50, 7), judge("e1b", "s1b", 20), judge("e2", "s2", 90)], runs: [PIPELINE, REEVALUATION],
});

/** Mirrors the application source: fixed bindings for the scope, current results filtered by runIds. */
function sourceOf(all: MetricsFacts): MetricsSource & { read: ReturnType<typeof vi.fn<MetricsSource["read"]>> } {
  return { read: vi.fn<MetricsSource["read"]>(async (query: MetricsQuery) => {
    const ids = query.datasetId !== undefined
      ? all.plan.datasets.find((item) => item.datasetId === query.datasetId)?.projectSampleIds ?? []
      : query.projectSampleId !== undefined ? [query.projectSampleId]
        : query.samplingId !== undefined ? all.samplings.filter((item) => item.samplingId === query.samplingId).map((item) => item.projectSampleId)
          : all.projectSamples.map((item) => item.projectSampleId);
    const runs = query.runIds === undefined ? undefined : all.runs.filter((item) => query.runIds!.includes(item.runId));
    const samplings = all.samplings.filter((item) => ids.includes(item.projectSampleId)
      && (!runs || runs.some((selected) => selected.samplingIds.includes(item.samplingId))));
    const evaluations = all.evaluations.filter((item) => samplings.some((selected) => selected.samplingId === item.samplingId)
      && (!runs || runs.some((selected) => selected.evaluationIds.includes(item.evaluationId))));
    return { ...all, projectSamples: all.projectSamples.filter((item) => ids.includes(item.projectSampleId)), samplings, evaluations };
  }) };
}

const metricsOf = (all: MetricsFacts = CURRENT) => createMetrics({ source: sourceOf(all) });
const scope = { projectId: PROJECT.projectId };
const scoreOf = (summary: MetricSummary) => summary.evaluationOutputs.fields.find((field) => field.jsonPointer === "/score")!;

describe("four-level reporting", () => {
  it("recomputes per-Agent mean, variance, median and range at all four levels", async () => {
    const metrics = metricsOf();
    const project = await metrics.getProjectOverview(scope);
    const datasetView = await metrics.getDatasetOverview({ ...scope, datasetId: D1 });
    const sample = await metrics.getSampleOverview({ ...scope, projectSampleId: "ps-1" });
    const detail = await metrics.getSamplingDetail({ ...scope, samplingId: "s1a" });
    for (const summary of [project.summary, datasetView.summary]) {
      const stats = summary.executionAgent.distribution.tokens.total;
      expect(stats).toMatchObject({ count: 3, missing: 0, min: 100, max: 400, median: 200, mean: 700 / 3 });
      expect(stats.variance).toBeCloseTo(140000 / 9);
    }
    expect(sample.summary.executionAgent.distribution.tokens.total).toMatchObject({ count: 2, mean: 150, variance: 2500, median: 150, min: 100, max: 200 });
    expect(detail.summary.executionAgent.distribution.tokens.total).toMatchObject({ count: 1, mean: 100, variance: 0, median: 100, min: 100, max: 100 });
  });

  it("builds the Project from the fixed plan and deduplicates shared ProjectSamples", async () => {
    const result = await metricsOf().getProjectOverview(scope);
    expect(result.project).toEqual(PROJECT);
    expect(result.projectSamples.map((row) => [row.projectSampleId, row.samplingIds.length])).toEqual([["ps-1", 2], ["ps-2", 1], ["ps-3", 0]]);
    expect(new Set(result.projectSamples.map((row) => row.projectSampleId)).size).toBe(3);
    expect(result.runIds).toEqual(["pipeline-run", "reevaluation-run"]);
    expect(result.summary.counts).toEqual({ datasets: 2, data: 3, projectSamples: 3, samplings: 3, evaluations: 3 });
    expect(result.datasets.map((row) => [row.dataset.datasetId, row.dataset.name, row.summary.counts])).toEqual([
      [D1, `Dataset ${D1}`, { datasets: 1, data: 3, projectSamples: 3, samplings: 3, evaluations: 3 }],
      [D2, `Dataset ${D2}`, { datasets: 1, data: 1, projectSamples: 1, samplings: 2, evaluations: 2 }],
    ]);
    expect(scoreOf(result.summary)).toMatchObject({ observationCount: 3, contributingEvaluationCount: 3, numeric: { total: 160 } });
    expect(result.summary.executionAgent.tokens.total.value).toBe(700);
    expect(result.summary.evaluationAgents.tokens.total.value).toBe(9);
  });

  it("recomputes every level from raw observations instead of averaging child averages", async () => {
    const metrics = metricsOf();
    const datasetView = await metrics.getDatasetOverview({ ...scope, datasetId: D1 });
    expect(scoreOf(datasetView.summary).numeric).toMatchObject({ count: 3, total: 160, mean: 160 / 3, median: 50 });
    const [first, second] = datasetView.projectSamples;
    expect(scoreOf(first!.summary).numeric?.mean).toBe(35);
    expect(scoreOf(second!.summary).numeric?.mean).toBe(90);
    expect(datasetView.summary.execution.agentDurationMs).toMatchObject({ count: 3, total: 3_000 });
  });

  it("shows never-run ProjectSamples with unavailable values instead of zero", async () => {
    const metrics = metricsOf();
    const datasetView = await metrics.getDatasetOverview({ ...scope, datasetId: D1 });
    expect(datasetView.projectSamples.map((row) => [row.projectSampleId, row.samplingCount, row.summary.counts.samplings])).toEqual([
      ["ps-1", 2, 2], ["ps-2", 1, 1], ["ps-3", 1, 0],
    ]);
    const never = await metrics.getSampleOverview({ ...scope, projectSampleId: "ps-3" });
    expect(never).toMatchObject({ projectSample: PS3, samplings: [], runIds: [] });
    expect(never.summary.counts).toEqual({ datasets: 1, data: 1, projectSamples: 1, samplings: 0, evaluations: 0 });
    expect(never.summary.executionAgent.tokens.total).toEqual({ value: null, coverage: "unavailable" });
    expect(never.summary.execution.successRate).toBeNull();
    expect(scoreOf(never.summary)).toMatchObject({ observationCount: 0, coverage: "unavailable", numeric: { total: null } });
  });

  it("repeats a shared ProjectSample in each Dataset view", async () => {
    const view = await metricsOf().getDatasetOverview({ ...scope, datasetId: D2 });
    expect(view.dataset).toEqual(PLAN.datasets[1]);
    expect(view.projectSamples.map((row) => [row.projectSampleId, row.datasetIds])).toEqual([["ps-1", [D1, D2]]]);
    expect(scoreOf(view.summary).numeric?.total).toBe(70);
  });

  it("keeps unselected results by default and filters only current results by runIds", async () => {
    const metrics = metricsOf();
    const filtered = await metrics.getProjectOverview({ ...scope, runIds: ["reevaluation-run"] });
    expect(filtered.runIds).toEqual(["reevaluation-run"]);
    expect(filtered.projectSamples.flatMap((row) => row.samplingIds)).toHaveLength(1);
    expect(filtered.summary.counts).toEqual({ datasets: 2, data: 3, projectSamples: 3, samplings: 1, evaluations: 1 });
    expect(filtered.datasets.map((row) => row.dataset.datasetId)).toEqual([D1, D2]);
    expect(scoreOf(filtered.summary).numeric?.total).toBe(50);
    const pipeline = await metrics.getProjectOverview({ ...scope, runIds: ["pipeline-run"] });
    expect(pipeline.summary.counts).toMatchObject({ samplings: 3, evaluations: 2 });
    const datasetView = await metrics.getDatasetOverview({ ...scope, datasetId: D1, runIds: ["reevaluation-run"] });
    expect(datasetView.projectSamples).toHaveLength(3);
  });

  it("replaces only the re-evaluated numbers and leaves execution metrics unchanged", async () => {
    const before = facts({ ...CURRENT, evaluations: [judge("e1a", "s1a", 10), ...CURRENT.evaluations.slice(1)], runs: [PIPELINE] });
    const [old, current] = await Promise.all([metricsOf(before).getProjectOverview(scope), metricsOf().getProjectOverview(scope)]);
    expect(scoreOf(old.summary).numeric?.total).toBe(120);
    expect(scoreOf(current.summary).numeric?.total).toBe(160);
    expect(current.summary.executionAgent).toEqual(old.summary.executionAgent);
    expect(current.summary.execution).toEqual(old.summary.execution);
    const [oldDetail, currentDetail] = await Promise.all([
      metricsOf(before).getSamplingDetail({ ...scope, samplingId: "s1a" }), metricsOf().getSamplingDetail({ ...scope, samplingId: "s1a" }),
    ]);
    expect(currentDetail.subject).toEqual(oldDetail.subject);
    expect(currentDetail.evaluations.map((item) => item.record.evaluationId)).toEqual(["e1a2"]);
  });

  it("separates the Subject from each Evaluator and exposes full JSON only in Sampling detail", async () => {
    const subject = SAMPLINGS[0]!;
    const withTrajectory = facts({ ...CURRENT, samplings: [{ ...subject, executionAttempts: [{ ...subject.executionAttempts[0]!, resources: collection({
      usageEvents: [usage("u", { metrics: { totalTokens: 100 } })],
      telemetryEvents: [
        telemetry("t:s", "turn.started", "turn", {}, 0), telemetry("t:f", "turn.finished", "turn", { outcome: "completed" }, 9),
        telemetry("x:s", "tool.started", "tool", { toolName: "browser", input: { url: "a" } }, 1, "session-1", "turn"),
      ],
    }) }] }, ...SAMPLINGS.slice(1)], evaluations: [...CURRENT.evaluations, judge("e1a3", "s1a", 70, 3)] });
    const detail = await metricsOf(withTrajectory).getSamplingDetail({ ...scope, samplingId: "s1a" });
    expect(detail.projectSample).toEqual(PS1);
    expect(detail.subject).toMatchObject({ role: "subject", chatId: "subject:s1a", resources: { tokens: { total: { value: 100 } } } });
    expect(detail.subject.resources.trajectory).toMatchObject({ turns: { count: { value: 1 } }, tools: { count: { value: 1 } }, contentTurns: { value: null, coverage: "unavailable" } });
    expect(detail.evaluations.map((item) => [item.agent.role, item.agent.chatId, item.agent.resources.tokens.total.value])).toEqual([
      ["evaluator", "judge:e1a2", 7], ["evaluator", "judge:e1a3", 3],
    ]);
    expect(detail.evaluations[0]!.output).toMatchObject({
      rawJson: { score: 50, scores: [{ value: 5 }] }, validation: { status: "valid" },
      observations: [{ jsonPointer: "/score", kinds: ["number"], value: 50 }, { jsonPointer: "/scores/*/value", instancePointer: "/scores/0/value", kinds: ["integer"], value: 5 }],
    });
    expect(detail.summary.evaluationAgents.tokens.total.value).toBe(10);
    expect(detail.summary.executionAgent.tokens.total.value).toBe(100);
    const sampleView = await metricsOf(withTrajectory).getSampleOverview({ ...scope, projectSampleId: "ps-1" });
    expect(sampleView.samplings.map((row) => [row.samplingId, row.summary.counts.evaluations, row.artifactCount, row.hasTrajectory])).toEqual([
      ["s1a", 2, 1, true], ["s1b", 1, 1, true],
    ]);
    expect(sampleView.samplings[0]).not.toHaveProperty("evaluations");
  });

  it("shows execution metrics without an evaluation plan and marks numbers unavailable", async () => {
    const result = await metricsOf(facts({ plan: plan(PLAN.datasets, false), projectSamples: [PS1, PS2, PS3], samplings: SAMPLINGS }))
      .getProjectOverview(scope);
    expect(result.summary.evaluationOutputs).toEqual({
      schema: null, coverage: "unavailable", evaluations: 0, validation: { valid: 0, invalid: 0, unavailable: 0 }, fields: [],
    });
    expect(result.summary.executionAgent.tokens.total.value).toBe(700);
  });

  it.each([
    { type: "object", oneOf: [
      { properties: { mode: { const: "measured" }, passed: { type: "boolean" } }, required: ["mode"] },
      { properties: { mode: { const: "skipped" }, passed: { type: "null" } }, required: ["mode"] },
    ] },
    { type: "object", properties: { passed: { type: ["boolean", "null"], anyOf: [true, false] } } },
    { type: "object", properties: { passed: { type: ["boolean", "null"], if: { const: true }, then: { const: true } } } },
  ] satisfies EvaluationOutputSchema[])("uses the same nullable observations in every level and detail: %j", async (evaluationOutputSchema) => {
    const metrics = metricsOf(facts({
      plan: plan([dataset(D1, ["ps-1"])]), projectSamples: [projectSample("ps-1", [D1])],
      samplings: [sampling()], evaluations: [
        evaluation("e1", {}, { mode: "measured", passed: true }), evaluation("e2", {}, { mode: "skipped", passed: null }),
      ],
      evaluationOutputSchema,
    }));
    const views = await Promise.all([
      metrics.getProjectOverview(scope), metrics.getDatasetOverview({ ...scope, datasetId: D1 }),
      metrics.getSampleOverview({ ...scope, projectSampleId: "ps-1" }), metrics.getSamplingDetail({ ...scope, samplingId: "sampling-1" }),
    ]);
    for (const view of views) {
      const field = view.summary.evaluationOutputs.fields.find((item) => item.jsonPointer === "/passed");
      expect(field).toMatchObject({ observationCount: 2, contributingEvaluationCount: 2, missingEvaluationCount: 0, nullCount: 1, diagnostics: [] });
      expect(field?.distribution).toEqual([
        { value: true, count: 1, share: 0.5, evaluations: 1 }, { value: false, count: 0, share: 0, evaluations: 0 },
      ]);
    }
    const detail = views[3]!;
    expect(detail.evaluations[1]!.output.observations).toContainEqual({ jsonPointer: "/passed", instancePointer: "/passed", kinds: [], value: null });
  });

  it("excludes values admitted only by an undeclared branch from every level and detail", async () => {
    const metrics = metricsOf(facts({
      plan: plan([dataset(D1, ["ps-1"])]), projectSamples: [projectSample("ps-1", [D1])], samplings: [sampling()],
      evaluations: [evaluation("e1", {}, { passed: false }), evaluation("e2", {}, { passed: true })],
      evaluationOutputSchema: { type: "object", properties: { passed: { anyOf: [{ type: "boolean", not: { const: false } }, {}] } } },
    }));
    const views = await Promise.all([
      metrics.getProjectOverview(scope), metrics.getDatasetOverview({ ...scope, datasetId: D1 }),
      metrics.getSampleOverview({ ...scope, projectSampleId: "ps-1" }), metrics.getSamplingDetail({ ...scope, samplingId: "sampling-1" }),
    ]);
    for (const view of views) {
      expect(view.summary.evaluationOutputs.validation).toEqual({ valid: 2, invalid: 0, unavailable: 0 });
      expect(view.summary.evaluationOutputs.fields).toHaveLength(1);
      expect(view.summary.evaluationOutputs.fields[0]).toMatchObject({
        jsonPointer: "/passed", observationCount: 1, contributingEvaluationCount: 1, missingEvaluationCount: 1,
        distribution: [{ value: true, count: 1, share: 1, evaluations: 1 }], diagnostics: [{ reason: "absent", evaluations: 1 }],
      });
    }
    const detail = views[3]!;
    expect(detail.evaluations[0]!.output).toMatchObject({ rawJson: { passed: false }, validation: { status: "valid" }, observations: [] });
    expect(detail.evaluations[1]!.output.observations).toEqual([{ jsonPointer: "/passed", instancePointer: "/passed", value: true, kinds: ["boolean"] }]);
  });

  it("serves one Schema-derived presentation and observation contract through all four views", async () => {
    const metrics = metricsOf(facts({
      plan: plan([dataset(D1, ["ps-1"])]), projectSamples: [projectSample("ps-1", [D1])], samplings: [sampling()],
      evaluations: [
        evaluation("e1", {}, { verdict: "a", score: 2, passed: true }),
        evaluation("e2", {}, { verdict: "b", score: 4, passed: false }),
      ],
      evaluationOutputSchema: {
        $dynamicAnchor: "result", type: ["boolean", "object"],
        $defs: { score: { $anchor: "score", title: "Quality", description: "Overall quality score", type: "number" } },
        properties: {
          verdict: { title: "Decision", if: { const: "a" }, then: { type: "string" }, else: { enum: ["a", "b"] } },
          score: { $ref: "#score" }, passed: { title: "Passed", type: "boolean", $dynamicRef: "#result" },
          optional: { type: "number" },
        },
      },
    }));
    const views = await Promise.all([
      metrics.getProjectOverview(scope), metrics.getDatasetOverview({ ...scope, datasetId: D1 }),
      metrics.getSampleOverview({ ...scope, projectSampleId: "ps-1" }), metrics.getSamplingDetail({ ...scope, samplingId: "sampling-1" }),
    ]);
    for (const view of views) {
      const outputs = view.summary.evaluationOutputs;
      expect(outputs.validation).toEqual({ valid: 2, invalid: 0, unavailable: 0 });
      expect(outputs.fields.find((field) => field.jsonPointer === "/score")).toMatchObject({
        title: "Quality", description: "Overall quality score", numeric: { count: 2, total: 6 }, coverage: "complete",
      });
      expect(outputs.fields.find((field) => field.jsonPointer === "/verdict")).toMatchObject({
        title: "Decision", observationCount: 1, missingEvaluationCount: 1, coverage: "partial",
        distribution: [{ value: "b", count: 1, share: 1, evaluations: 1 }],
      });
      expect(outputs.fields.find((field) => field.jsonPointer === "/passed")).toMatchObject({ title: "Passed", observationCount: 2, coverage: "complete" });
      expect(outputs.fields.find((field) => field.jsonPointer === "/optional")).toMatchObject({
        title: "/optional", description: null, observationCount: 0, missingEvaluationCount: 2, coverage: "unavailable",
      });
    }
    const detail = views[3]!;
    expect(detail.evaluations[0]!.output.rawJson).toMatchObject({ verdict: "a" });
    expect(detail.evaluations[0]!.output.observations.map((observation) => observation.jsonPointer)).toEqual(["/score", "/passed"]);
    expect(detail.evaluations[1]!.output.observations.map((observation) => observation.jsonPointer)).toEqual(["/verdict", "/score", "/passed"]);
  });

  it("validates queries and passes a detached copy to the source", async () => {
    const source = sourceOf(CURRENT);
    const metrics = createMetrics({ source });
    await expect(metrics.getProjectOverview({ projectId: "" })).rejects.toBeInstanceOf(MetricsQueryError);
    await expect(metrics.getProjectOverview({ ...scope, runIds: [] })).rejects.toBeInstanceOf(MetricsQueryError);
    await expect(metrics.getProjectOverview({ ...scope, runIds: ["r", "r"] })).rejects.toBeInstanceOf(MetricsQueryError);
    await expect(metrics.getSampleOverview({ ...scope, projectSampleId: "" })).rejects.toBeInstanceOf(MetricsQueryError);
    expect(source.read).not.toHaveBeenCalled();
    const query = { ...scope, projectSampleId: "ps-1", extra: true };
    await metrics.getSampleOverview(query);
    expect(source.read).toHaveBeenCalledWith({ projectId: PROJECT.projectId, projectSampleId: "ps-1" });
    expect(source.read.mock.calls[0]![0]).not.toBe(query);
  });

  it.each([
    ["dataset", (metrics: ReturnType<typeof metricsOf>) => metrics.getDatasetOverview({ ...scope, datasetId: "missing" })],
    ["project-sample", (metrics: ReturnType<typeof metricsOf>) => metrics.getSampleOverview({ ...scope, projectSampleId: "missing" })],
    ["sampling", (metrics: ReturnType<typeof metricsOf>) => metrics.getSamplingDetail({ ...scope, samplingId: "missing" })],
    ["run", (metrics: ReturnType<typeof metricsOf>) => metrics.getProjectOverview({ ...scope, runIds: ["missing"] })],
  ] as const)("reports an unknown %s", async (entity, query) => {
    await expect(query(metricsOf())).rejects.toMatchObject({ name: "MetricsEntityNotFoundError", entity, id: "missing" });
  });

  it("reports a Sampling filtered out by runIds as not found", async () => {
    await expect(metricsOf().getSamplingDetail({ ...scope, samplingId: "s2", runIds: ["reevaluation-run"] }))
      .rejects.toBeInstanceOf(MetricsEntityNotFoundError);
  });

  it.each([
    ["wrong Project", { plan: { ...PLAN, project: { ...PROJECT, projectId: "other" } } }],
    ["Schema without plan", { evaluationOutputSchema: null }],
    ["missing bound ProjectSample", { projectSamples: [PS1, PS2] }],
    ["duplicate ProjectSample", { projectSamples: [PS1, PS2, PS3, PS3] }],
    ["unbound ProjectSample", { projectSamples: [PS1, PS2, PS3, projectSample("ps-x", [D1])] }],
    ["drifted Dataset binding", { projectSamples: [{ ...PS1, datasetIds: [D1] }, PS2, PS3] }],
    ["duplicate Dataset member", { plan: plan([dataset(D1, ["ps-1", "ps-1", "ps-2", "ps-3"]), dataset(D2, ["ps-1"])]) }],
    ["Sampling outside scope", { samplings: [...SAMPLINGS, subjectRun("sx", "ps-x", 1)] }],
    ["Sampling of another Project", { samplings: [{ ...SAMPLINGS[0]!, projectId: "other" }] }],
    ["duplicate Sampling", { samplings: [...SAMPLINGS, SAMPLINGS[0]!] }],
    ["orphan Evaluation", { evaluations: [judge("ex", "missing", 1)] }],
    ["duplicate Evaluation", { evaluations: [...CURRENT.evaluations, CURRENT.evaluations[0]!] }],
    ["duplicate Run", { runs: [PIPELINE, PIPELINE] }],
  ] as const)("rejects inconsistent source facts: %s", async (_, patch) => {
    const read = vi.fn<MetricsSource["read"]>(async () => ({ ...CURRENT, ...patch } as MetricsFacts));
    await expect(createMetrics({ source: { read } }).getProjectOverview(scope)).rejects.toBeInstanceOf(MetricsSourceError);
  });

  it("rejects a Dataset view missing one of its bound ProjectSamples", async () => {
    const read = vi.fn<MetricsSource["read"]>(async () => ({ ...CURRENT, projectSamples: [PS1, PS2] }));
    await expect(createMetrics({ source: { read } }).getDatasetOverview({ ...scope, datasetId: D1 })).rejects.toBeInstanceOf(MetricsSourceError);
  });

  it("does not mutate source facts", async () => {
    const snapshot = structuredClone(CURRENT);
    const detail = await metricsOf().getSamplingDetail({ ...scope, samplingId: "s1a" });
    Object.assign(detail.sampling, { samplingId: "changed" });
    expect(CURRENT).toEqual(snapshot);
    expect(OUTPUT_SCHEMA).toEqual(snapshot.evaluationOutputSchema);
  });
});
