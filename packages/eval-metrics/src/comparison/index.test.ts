import type { EvaluationOutputSchema, JsonValue } from "@eval-platform/eval-contracts";
import { describe, expect, it } from "vitest";
import {
  createProjectComparison, MetricsEntityNotFoundError, MetricsQueryError, MetricsSourceError,
  type MetricsFacts, type ProjectComparisonQuery,
} from "../index.js";
import {
  collection, dataset, evaluation, facts, nativeScopedFixture, plan, projectSample, sampling, settlement, usage,
} from "../test-support.js";

const DATA_1 = "10000000-0000-4000-8000-000000000001";
const DATA_2 = "10000000-0000-4000-8000-000000000002";
const DATA_3 = "10000000-0000-4000-8000-000000000003";
const PROJECT_IDS = ["left", "right"];
const NUMERIC_SCHEMA: EvaluationOutputSchema = {
  type: "object", properties: { score: { type: "number", title: "Quality", description: "Measured quality" } },
};

interface Case {
  readonly dataId: string;
  readonly results: readonly (JsonValue | string)[];
  readonly datasetIds?: readonly string[];
}

function projectFacts(projectId: string, schema: EvaluationOutputSchema, cases: readonly Case[]): MetricsFacts {
  const samples = cases.map((item, index) => ({
    ...projectSample(`${projectId}:ps:${index}`, item.datasetIds ?? ["dataset-1"], item.dataId, item.results.length), projectId,
  }));
  const datasets = [...new Set(samples.flatMap((sample) => sample.datasetIds))]
    .map((id) => dataset(id, samples.filter((sample) => sample.datasetIds.includes(id)).map((sample) => sample.projectSampleId)));
  const base = plan(datasets);
  const samplings = cases.flatMap((item, index) => item.results.map((_, resultIndex) => sampling(`${projectId}:s:${index}:${resultIndex}`, {
    projectId, projectSampleId: samples[index]!.projectSampleId,
  })));
  const evaluations = cases.flatMap((item, index) => item.results.map((result, resultIndex) =>
    evaluation(`${projectId}:e:${index}:${resultIndex}`, { samplingId: `${projectId}:s:${index}:${resultIndex}` }, result)));
  return facts({
    plan: { ...base, project: { ...base.project, projectId, name: projectId } }, projectSamples: samples,
    evaluationOutputSchema: schema, samplings, evaluations,
  });
}

const comparisonOf = (...records: readonly MetricsFacts[]) => createProjectComparison({ source: { read: async () => records } });

describe("scored Project intersection comparison", () => {
  it("excludes confirmed Data before every group and raw-observation aggregate and restores the whole scored intersection", async () => {
    const left = projectFacts("left", NUMERIC_SCHEMA, [
      { dataId: DATA_1, datasetIds: ["one", "shared"], results: [{ score: 0 }, { score: 10 }] },
      { dataId: DATA_2, datasetIds: ["shared", "two"], results: [{ score: 100 }] },
    ]);
    const right = projectFacts("right", NUMERIC_SCHEMA, [
      { dataId: DATA_1, datasetIds: ["one", "shared"], results: [{ score: 20 }] },
      { dataId: DATA_2, datasetIds: ["shared", "two"], results: [{ score: 200 }, { score: 400 }] },
    ]);
    const comparison = comparisonOf(left, right);
    const selected = await comparison.getComparison({ projectIds: PROJECT_IDS, excludedDataIds: [DATA_2] });
    expect(selected.rows.map((row) => row.dataId)).toEqual([DATA_1]);
    expect(selected.fields[0]?.dataCount).toBe(1);
    expect(selected.datasets.map((item) => [item.datasetId, item.dataCount])).toEqual([["one", 1], ["shared", 1]]);
    expect(selected.summary.map((item) => [item.dataCount, item.samplingCount, item.score?.numeric?.mean])).toEqual([[1, 2, 5], [1, 1, 20]]);
    const empty = await comparison.getComparison({ projectIds: PROJECT_IDS, excludedDataIds: [DATA_1, DATA_2] });
    expect(empty.selectedField?.jsonPointer).toBe("/score");
    expect(empty.rows).toEqual([]);
    expect(empty.datasets).toEqual([]);
    expect(empty.summary.map((item) => [item.dataCount, item.samplingCount, item.score])).toEqual([[0, 0, null], [0, 0, null]]);
    const restored = await comparison.getComparison({ projectIds: PROJECT_IDS, excludedDataIds: [] });
    expect(restored.rows.map((row) => row.dataId)).toEqual([DATA_1, DATA_2]);
    expect(restored.summary.map((item) => item.score?.numeric?.mean)).toEqual([110 / 3, 620 / 3]);
    expect(left.projectSamples).toHaveLength(2);
    expect(right.samplings).toHaveLength(3);
  });

  it("compares the common numeric field across different Schemas and retains a real zero", async () => {
    const left = projectFacts("left", NUMERIC_SCHEMA, [
      { dataId: DATA_1, results: [{ score: 0 }] }, { dataId: DATA_2, results: [{ score: 8 }] },
    ]);
    const right = projectFacts("right", {
      type: "object", required: ["extra"],
      properties: { score: { type: "integer" }, extra: { type: "boolean" } },
    }, [
      { dataId: DATA_1, results: [{ score: 4, extra: true }] }, { dataId: DATA_3, results: [{ score: 20, extra: false }] },
    ]);
    const view = await comparisonOf(left, right).getComparison({ projectIds: PROJECT_IDS });
    expect(view.fields).toEqual([{
      jsonPointer: "/score", title: "Quality", description: "Measured quality", kinds: ["number"], values: [], nullable: false, dataCount: 1,
    }]);
    expect(view.selectedField).toEqual(view.fields[0]);
    expect(view.summary.map((item) => [item.projectId, item.dataCount, item.score?.numeric?.mean])).toEqual([
      ["left", 1, 0], ["right", 1, 4],
    ]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({
      dataId: DATA_1, data: left.projectSamples[0]!.data, inputChanged: false, spread: 4, different: true,
      projects: [
        { projectId: "left", projectSampleId: "left:ps:0", samplingIds: ["left:s:0:0"], samplingCount: 1, evaluationCount: 1 },
        { projectId: "right", projectSampleId: "right:ps:0", samplingIds: ["right:s:0:0"], samplingCount: 1, evaluationCount: 1 },
      ],
    });
  });

  it("keeps false observations but excludes null, failed, absent and invalid evaluations from the scored scope", async () => {
    const schema: EvaluationOutputSchema = {
      type: "object", properties: { checks: { type: "array", items: { type: ["boolean", "null"] } } },
    };
    const base = projectFacts("left", schema, [
      { dataId: DATA_1, results: [
        { checks: [false, null] }, { checks: [null] }, '{"checks":[false],"checks":[false]}',
        { checks: [true] }, { checks: [true] }, { checks: [true] }, { checks: ["wrong"] }, { checks: [true] },
      ] },
      { dataId: DATA_2, results: [{ checks: [null] }] }, { dataId: DATA_3, results: [] },
    ]);
    const left: MetricsFacts = {
      ...base,
      evaluations: base.evaluations.map((record, index) => {
        if (index === 3) return { ...record, status: { status: "failed" } };
        if (index === 4) return { ...record, output: { ...record.output!, status: "failed" } };
        if (index === 5) {
          const { output: _, ...missing } = record;
          return missing;
        }
        if (index === 7) {
          const { structuredOutput: _, ...missing } = record.output!;
          return { ...record, output: missing };
        }
        return record;
      }),
    };
    const right = projectFacts("right", schema, [
      { dataId: DATA_1, results: [{ checks: [false, false, null] }] },
      { dataId: DATA_2, results: [{ checks: [false] }] }, { dataId: DATA_3, results: [{ checks: [true] }] },
    ]);
    const view = await comparisonOf(left, right).getComparison({ projectIds: PROJECT_IDS });
    expect(view.fields.map((field) => [field.jsonPointer, field.dataCount])).toEqual([["/checks/*", 1]]);
    expect(view.rows.map((row) => row.dataId)).toEqual([DATA_1]);
    expect(view.summary[0]).toMatchObject({
      dataCount: 1, samplingCount: 1, evaluationCount: 1,
      score: {
        kinds: ["boolean"], observationCount: 1, contributingEvaluationCount: 1, missingEvaluationCount: 0,
        numeric: null, nullCount: 0, coverage: "complete", diagnostics: [],
        distribution: [{ value: true, count: 0, share: 0 }, { value: false, count: 1, share: 1 }],
      },
    });
    expect(view.summary[1]!.score).toMatchObject({ observationCount: 2, nullCount: 0 });
    expect(view.rows[0]).toMatchObject({ spread: null, different: false });
    expect(view.rows[0]!.projects[0]!.samplingIds).toEqual(["left:s:0:0"]);
  });

  it("switches per-field scored intersections and narrows them by the union of frozen Dataset memberships", async () => {
    const schema: EvaluationOutputSchema = {
      type: "object", properties: {
        unscored: { type: "number" }, score: { type: ["number", "null"] }, passed: { type: ["boolean", "null"] },
      },
    };
    const left = projectFacts("left", schema, [
      { dataId: DATA_1, datasetIds: ["shared", "left-only"], results: [{ score: 0, passed: null }] },
      { dataId: DATA_2, datasetIds: ["left-only"], results: [{ score: null, passed: false }] },
      { dataId: DATA_3, datasetIds: ["shared"], results: [{ score: 8, passed: true }] },
    ]);
    const right = projectFacts("right", schema, [
      { dataId: DATA_1, datasetIds: ["right-only"], results: [{ score: 4, passed: true }] },
      { dataId: DATA_2, datasetIds: ["right-only"], results: [{ score: 6, passed: false }] },
      { dataId: DATA_3, datasetIds: ["shared", "passed-only"], results: [{ score: null, passed: true }] },
    ]);
    const comparison = comparisonOf(left, right);
    const initial = await comparison.getComparison({ projectIds: PROJECT_IDS });
    expect(initial.fields.map((field) => [field.jsonPointer, field.dataCount])).toEqual([["/score", 1], ["/passed", 2]]);
    expect(initial.selectedField?.jsonPointer).toBe("/score");
    expect(initial.rows.map((row) => [row.dataId, row.datasetIds])).toEqual([[DATA_1, ["shared", "left-only", "right-only"]]]);
    expect(initial.datasets.map((item) => [item.datasetId, item.dataCount])).toEqual([["shared", 1], ["left-only", 1], ["right-only", 1]]);
    const allPassed = await comparison.getComparison({ projectIds: PROJECT_IDS, jsonPointer: "/passed" });
    expect(allPassed.rows.map((row) => row.dataId)).toEqual([DATA_2, DATA_3]);
    const narrowed = await comparison.getComparison({ projectIds: PROJECT_IDS, jsonPointer: "/passed", datasetId: "shared" });
    expect(narrowed.fields).toEqual(initial.fields);
    expect(narrowed.datasets).toEqual(allPassed.datasets);
    expect(narrowed.rows.map((row) => row.dataId)).toEqual([DATA_3]);
    expect(narrowed.summary.map((item) => [item.dataCount, item.samplingCount, item.evaluationCount])).toEqual([[1, 1, 1], [1, 1, 1]]);
    const union = await comparison.getComparison({ projectIds: PROJECT_IDS, jsonPointer: "/passed", datasetId: "right-only" });
    expect(union.rows.map((row) => row.dataId)).toEqual([DATA_2]);
    for (const query of [
      { jsonPointer: "/score", datasetId: "stale" },
      { jsonPointer: "/score", datasetId: "passed-only" },
      { jsonPointer: "/unscored" },
      { jsonPointer: "/removed" },
    ]) {
      const empty = await comparison.getComparison({ projectIds: PROJECT_IDS, ...query });
      expect(empty.rows).toEqual([]);
      expect(empty.datasetId).toBe(query.datasetId ?? null);
      expect(empty.summary.map((item) => [item.dataCount, item.samplingCount, item.evaluationCount, item.score])).toEqual([
        [0, 0, 0, null], [0, 0, 0, null],
      ]);
      if (query.datasetId === undefined) expect(empty.selectedField).toBeNull();
    }
  });

  it("compares normalized boolean and enum distributions rather than unequal observation counts or enum order", async () => {
    const schema = (values: readonly string[]): EvaluationOutputSchema => ({
      type: "object", properties: {
        flags: { type: "array", items: { type: "boolean" } },
        labels: { type: "array", items: { enum: [...values] } },
      },
    });
    const left = projectFacts("left", schema(["good", "bad"]), [
      { dataId: DATA_1, results: [{ flags: [true, false], labels: ["good", "bad"] }] },
      { dataId: DATA_2, results: [{ flags: [false], labels: ["good"] }] },
    ]);
    const right = projectFacts("right", schema(["bad", "good"]), [
      { dataId: DATA_1, results: [{ flags: [true, true, false, false], labels: ["bad", "good", "good", "bad"] }] },
      { dataId: DATA_2, results: [{ flags: [true], labels: ["bad"] }] },
    ]);
    for (const jsonPointer of ["/flags/*", "/labels/*"]) {
      const view = await comparisonOf(left, right).getComparison({ projectIds: PROJECT_IDS, jsonPointer });
      expect(view.rows.map((row) => [row.dataId, row.spread, row.different])).toEqual([[DATA_1, null, false], [DATA_2, null, true]]);
      expect(view.rows[0]!.projects.map((item) => item.score?.observationCount)).toEqual([2, 4]);
    }
  });

  it("does not merge incompatible statistical kinds or overlapping but different enum domains", async () => {
    const left = projectFacts("left", {
      type: "object", properties: {
        score: { type: "integer" }, category: { enum: ["a", "b"] }, rating: { enum: [0, 1] }, changed: { type: "boolean" },
      },
    }, [{ dataId: DATA_1, results: [{ score: 1, category: "b", rating: 1, changed: false }] }]);
    const right = projectFacts("right", {
      type: "object", properties: {
        score: { type: "number" }, category: { enum: ["b", "c"] }, rating: { enum: [0, 1, 2] }, changed: { type: "integer" },
      },
    }, [{ dataId: DATA_1, results: [{ score: 1.5, category: "b", rating: 1, changed: 0 }] }]);
    const comparison = comparisonOf(left, right);
    const view = await comparison.getComparison({ projectIds: PROJECT_IDS });
    expect(view.fields.map((field) => [field.jsonPointer, field.kinds])).toEqual([["/score", ["number"]]]);
    expect(view.rows[0]).toMatchObject({ spread: 0.5, different: true });
    expect((await comparison.getComparison({ projectIds: PROJECT_IDS, jsonPointer: "/category" })).selectedField).toBeNull();
  });

  it.each([
    null, [], {}, { projectIds: "left,right" }, { projectIds: [] }, { projectIds: ["left"] },
    { projectIds: ["left", "left"] }, { projectIds: ["left", " right"] }, { projectIds: ["left", 1] },
    { projectIds: ["left", ""] }, { projectIds: ["left", null] }, { projectIds: [, "right"] },
    { projectIds: PROJECT_IDS, datasetId: "" }, { projectIds: PROJECT_IDS, datasetId: " shared" },
    { projectIds: PROJECT_IDS, excludedDataIds: null }, { projectIds: PROJECT_IDS, excludedDataIds: DATA_1 },
    { projectIds: PROJECT_IDS, excludedDataIds: [DATA_1, DATA_1] }, { projectIds: PROJECT_IDS, excludedDataIds: [""] },
    { projectIds: PROJECT_IDS, datasetId: null }, { projectIds: PROJECT_IDS, jsonPointer: "score" },
    { projectIds: PROJECT_IDS, jsonPointer: "/bad~escape" }, { projectIds: PROJECT_IDS, jsonPointer: "/bad~" },
    { projectIds: PROJECT_IDS, jsonPointer: 1 }, { projectIds: PROJECT_IDS, jsonPointer: null },
  ].map((query) => ({ query })))("rejects an invalid comparison query before reading facts: $query", async ({ query }) => {
    const comparison = createProjectComparison({ source: { read: async () => { throw new Error("must not read"); } } });
    await expect(comparison.getComparison(query as unknown as ProjectComparisonQuery)).rejects.toBeInstanceOf(MetricsQueryError);
  });

  it("rejects duplicate, unexpected, cross-owner and internally inconsistent source facts", async () => {
    const left = projectFacts("left", NUMERIC_SCHEMA, [{ dataId: DATA_1, results: [{ score: 1 }] }]);
    const right = projectFacts("right", NUMERIC_SCHEMA, [{ dataId: DATA_1, results: [{ score: 2 }] }]);
    const invalid: readonly (readonly MetricsFacts[])[] = [
      [left, left, right],
      [left, right, projectFacts("other", NUMERIC_SCHEMA, [])],
      [left, { ...right, plan: { ...right.plan, project: { ...right.plan.project, ownerUserId: "other" } } }],
      [{ ...left, projectSamples: [] }, right],
      [{ ...left, samplings: [...left.samplings, left.samplings[0]!] }, right],
      [{ ...left, evaluations: [{ ...left.evaluations[0]!, samplingId: "outside" }] }, right],
      [{ ...left, samplings: [{ ...left.samplings[0]!, projectSampleId: "outside" }] }, right],
      [{ ...left, evaluationOutputSchema: null }, right],
      [projectFacts("left", NUMERIC_SCHEMA, [
        { dataId: DATA_1, results: [{ score: 1 }] }, { dataId: DATA_1, results: [{ score: 2 }] },
      ]), right],
      [{ ...left, projectSamples: [{ ...left.projectSamples[0]!, data: { ...left.projectSamples[0]!.data, dataId: DATA_2 } }] }, right],
    ];
    for (const records of invalid) {
      await expect(comparisonOf(...records).getComparison({ projectIds: PROJECT_IDS })).rejects.toBeInstanceOf(MetricsSourceError);
    }
  });

  it("reports a missing Project and preserves source errors", async () => {
    const left = projectFacts("left", NUMERIC_SCHEMA, []);
    await expect(comparisonOf(left).getComparison({ projectIds: PROJECT_IDS })).rejects.toMatchObject({
      name: "MetricsEntityNotFoundError", entity: "project", id: "right",
    });
    for (const error of [new MetricsSourceError("snapshot failed"), new MetricsEntityNotFoundError("project", "right"), new Error("database failed")]) {
      const comparison = createProjectComparison({ source: { read: async () => { throw error; } } });
      await expect(comparison.getComparison({ projectIds: PROJECT_IDS })).rejects.toBe(error);
    }
  });

  it("warns about changed frozen inputs without blocking different Agents and exposes only safe Agent metadata", async () => {
    const left = projectFacts("left", NUMERIC_SCHEMA, [
      { dataId: DATA_1, results: [{ score: 0 }] }, { dataId: DATA_2, results: [{ score: 3 }] },
    ]);
    const base = projectFacts("right", NUMERIC_SCHEMA, [
      { dataId: DATA_1, results: [{ score: 0 }] }, { dataId: DATA_2, results: [{ score: 3 }] },
    ]);
    const right: MetricsFacts = {
      ...base,
      plan: {
        ...base.plan,
        execution: {
          ...base.plan.execution, harness: { ...base.plan.execution.harness, framework: "codex" },
          subjectAgentConfig: {
            sourceUserAgentId: "other-agent", name: "Other execution Agent",
            body: { setting: { model: "provider/model-right" }, systemPrompt: "SECRET execution configuration" },
          },
        },
        evaluation: {
          ...base.plan.evaluation!,
          plan: {
            ...base.plan.evaluation!.plan,
            evaluatorAgentConfig: {
              sourceUserAgentId: "other-evaluator", name: "Other evaluation Agent", body: { prompt: "SECRET evaluation configuration" },
            },
          },
        },
      },
      projectSamples: base.projectSamples.map((sample, index) => ({
        ...sample,
        data: index === 0 ? { ...sample.data, userPrompt: "Changed task" } : {
          category: sample.data.category, evalPrompt: sample.data.evalPrompt, userPrompt: sample.data.userPrompt, dataId: sample.dataId,
        },
      })),
    };
    const view = await comparisonOf(left, right).getComparison({ projectIds: PROJECT_IDS });
    expect(view.rows.map((row) => [row.dataId, row.inputChanged, row.spread, row.different])).toEqual([
      [DATA_1, true, 0, false], [DATA_2, false, 0, false],
    ]);
    expect(view.projects[1]).toEqual({
      project: right.plan.project, executionAgentName: "Other execution Agent", evaluationAgentName: "Other evaluation Agent",
      framework: "codex", executionModel: "provider/model-right",
    });
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expect(view.rows[0]!.data).toEqual(left.projectSamples[0]!.data);
  });

  it("aggregates all raw observations and all Attempts of distinct scored Samplings without averaging rows or counting shared Data twice", async () => {
    const schema: EvaluationOutputSchema = {
      type: "object", properties: { scores: { type: "array", items: { type: ["number", "null"] } } },
    };
    const base = projectFacts("left", schema, [
      { dataId: DATA_1, datasetIds: ["main", "shared"], results: [{ scores: [0, 2, null] }, { scores: [4, 6] }, { scores: [null] }] },
      { dataId: DATA_2, datasetIds: ["main"], results: [{ scores: [20, 20] }] },
    ]);
    const resources = (id: string, units: number, input: number, cache: number, succeeded = true) => {
      const scope = { chatId: id, submissionId: id, idempotencyKey: id };
      // Real published UA SAFE Pi records, re-scoped to this Attempt. The
      // Tool's event outcome and Pi Tool Result must agree for each source.
      const nativeRecords = nativeScopedFixture(Array.from({ length: 16 }, (_, index) => index + 1), scope);
      const finished = nativeRecords[10]!.record.record;
      const toolResult = nativeRecords[9]!.record.record;
      if (finished.type !== "entry" || toolResult.type !== "entry") throw new Error("Expected native Tool records");
      (finished.value.data as { event: { payload: { outcome: string } } }).event.payload.outcome =
        succeeded ? "completed" : "failed";
      (toolResult.value.model as { isError: boolean }[])[0]!.isError = !succeeded;
      return collection({
        scope,
        usageEvents: [usage(id, { metrics: {
          inputTokens: input, cacheReadTokens: cache, outputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        } })],
        billingSettlements: [settlement(id, { debitedUnits: units })],
        nativeRecords,
      });
    };
    const left: MetricsFacts = {
      ...base,
      samplings: base.samplings.map((item, index) => {
        const first = item.executionAttempts[0]!;
        if (index === 0) return {
          ...item, executionAttempts: [
            { ...first, status: "failed", resources: resources("failed-attempt", 2, 3, 1, false) },
            {
              ...first, executionAttemptId: "second-attempt", attemptNumber: 2,
              startedAt: "2026-10-08T00:00:02.000Z", completedAt: "2026-10-08T00:00:04.000Z",
              resources: resources("successful-attempt", 4, 3, 1),
            },
          ],
        };
        return {
          ...item, executionAttempts: [{ ...first, resources: index === 1 ? resources("second-sampling", 2, 0, 12)
            : index === 2 ? resources("unscored-sampling", 1_000, 1_000, 1_000) : resources("second-data", 10, 4, 0, false) }],
        };
      }),
      evaluations: [...base.evaluations, evaluation("left:additional", { samplingId: base.samplings[0]!.samplingId }, { scores: [8, 10] })]
        .map((item) => ({ ...item, attempts: [{ ...item.attempts[0]!, resources: resources(item.evaluationId, 999, 999, 999) }] })),
    };
    const right = projectFacts("right", schema, [
      { dataId: DATA_1, datasetIds: ["main", "shared"], results: [{ scores: [4] }] },
      { dataId: DATA_2, datasetIds: ["main"], results: [{ scores: [6] }] },
    ]);
    const view = await comparisonOf(left, right).getComparison({ projectIds: PROJECT_IDS });
    expect(view.datasets.map((item) => [item.datasetId, item.dataCount])).toEqual([["main", 2], ["shared", 1]]);
    expect(view.summary[0]).toMatchObject({
      dataCount: 2, samplingCount: 3, evaluationCount: 4,
      score: {
        observationCount: 8, contributingEvaluationCount: 4, nullCount: 0,
        numeric: { count: 8, total: 70, mean: 8.75, min: 0, max: 20, median: 7, variance: 50.9375 },
      },
      resources: {
        chargedUnits: { value: 18, coverage: "complete" },
        chargedUnitsPerAgent: { count: 3, missing: 0, mean: 6, median: 6, min: 2, max: 10, total: 18, coverage: "complete" },
        agentDurationMs: { count: 3, mean: 2_000, total: 6_000, median: 1_000 },
        toolSuccessRate: { value: 0.5, coverage: "complete" },
      },
    });
    expect(view.summary[0]!.resources.cacheHitRate.value).toBeCloseTo(7 / 12);
    expect(view.summary[0]!.resources.chargedUnitsPerAgent.variance).toBeCloseTo(32 / 3);
    expect(view.rows[0]!.projects[0]).toMatchObject({
      samplingIds: ["left:s:0:0", "left:s:0:1"], samplingCount: 2, evaluationCount: 3,
      score: { observationCount: 6, numeric: { mean: 5 } },
    });
    expect(view.rows[1]!.projects[0]!.score?.numeric?.mean).toBe(20);
    const selected = await comparisonOf(left, right).getComparison({ projectIds: PROJECT_IDS, excludedDataIds: [DATA_2] });
    expect(selected.summary[0]).toMatchObject({
      dataCount: 1, samplingCount: 2, evaluationCount: 3,
      score: { numeric: { mean: 5, count: 6 } },
      resources: {
        chargedUnits: { value: 8, coverage: "complete" },
        chargedUnitsPerAgent: { mean: 4, total: 8 },
        agentDurationMs: { count: 2, total: 5_000, mean: 2_500 },
        toolSuccessRate: { value: 2 / 3, coverage: "complete" },
      },
    });
    expect(selected.summary[0]?.resources.cacheHitRate.value).toBeCloseTo(14 / 20);
  });

  it("preserves unavailable resource values instead of inventing zeros while retaining a scored zero", async () => {
    const left = projectFacts("left", NUMERIC_SCHEMA, [{ dataId: DATA_1, results: [{ score: 0 }] }]);
    const base = projectFacts("right", NUMERIC_SCHEMA, [{ dataId: DATA_1, results: [{ score: 0 }] }]);
    const right: MetricsFacts = {
      ...base, samplings: base.samplings.map((item) => ({
        ...item,
        executionAttempts: item.executionAttempts.map((attempt) => {
          const { resources: _, startedAt: _start, completedAt: _end, ...uncollected } = attempt;
          return uncollected;
        }),
      })),
    };
    const view = await comparisonOf(left, right).getComparison({ projectIds: PROJECT_IDS });
    expect(view.summary.map((item) => item.score?.numeric?.mean)).toEqual([0, 0]);
    expect(view.summary[0]!.resources.chargedUnits).toEqual({ value: 0, coverage: "complete" });
    expect(view.summary[1]!.resources).toMatchObject({
      chargedUnits: { value: null, coverage: "unavailable" },
      chargedUnitsPerAgent: { count: 0, missing: 1, mean: null, total: null, coverage: "unavailable" },
      agentDurationMs: { count: 0, missing: 1, mean: null, total: null },
      cacheHitRate: { value: null, coverage: "unavailable" }, toolSuccessRate: { value: null, coverage: "unavailable" },
    });
    expect(view.rows[0]).toMatchObject({ spread: 0, different: false });
  });

  it("discovers common escaped dynamic fields from actual Reader facts without requiring identical Schemas", async () => {
    const left = projectFacts("left", {
      type: "object", properties: { scores: { type: "object", additionalProperties: { $ref: "#/$defs/score" } } },
      $defs: { score: { type: ["integer", "null"], title: "Per check", description: "Dynamic quality" } },
    }, [
      { dataId: DATA_1, results: [{ scores: { "a/b~c": 0, unused: null } }] },
      { dataId: DATA_2, results: [{ scores: { "a/b~c": 2, other: 8 } }] },
    ]);
    const right = projectFacts("right", {
      type: "object", properties: { scores: { type: "object", patternProperties: { "^.+$": { type: ["number", "null"] } } } },
    }, [
      { dataId: DATA_1, results: [{ scores: { "a/b~c": 4, different: 6 } }] },
      { dataId: DATA_2, results: [{ scores: { "a/b~c": null, other: 3 } }] },
    ]);
    const view = await comparisonOf(left, right).getComparison({ projectIds: PROJECT_IDS, jsonPointer: "/scores/a~1b~0c" });
    expect(view.fields.map((field) => [field.jsonPointer, field.kinds, field.dataCount])).toEqual([
      ["/scores/a~1b~0c", ["number"], 1], ["/scores/other", ["number"], 1],
    ]);
    expect(view.selectedField).toMatchObject({ title: "Per check", description: "Dynamic quality" });
    expect(view.rows.map((row) => row.dataId)).toEqual([DATA_1]);
    expect(view.summary.map((item) => item.score?.numeric?.mean)).toEqual([0, 4]);
  });

  it("returns an empty scored scope for invalid Schemas, missing evaluation plans and disjoint Data", async () => {
    const left = projectFacts("left", NUMERIC_SCHEMA, [{ dataId: DATA_1, results: [{ score: 0 }] }]);
    const right = projectFacts("right", NUMERIC_SCHEMA, [{ dataId: DATA_1, results: [{ score: 1 }] }]);
    for (const unavailable of [
      { ...right, evaluationOutputSchema: { $ref: "#/missing" } },
      { ...right, plan: { ...right.plan, evaluation: null }, evaluationOutputSchema: null, evaluations: [] },
      projectFacts("right", NUMERIC_SCHEMA, [{ dataId: DATA_2, results: [{ score: 1 }] }]),
    ]) {
      const view = await comparisonOf(left, unavailable).getComparison({ projectIds: PROJECT_IDS });
      expect(view).toMatchObject({ fields: [], selectedField: null, datasets: [], rows: [] });
      expect(view.summary.map((item) => [item.dataCount, item.samplingCount, item.evaluationCount, item.score])).toEqual([
        [0, 0, 0, null], [0, 0, 0, null],
      ]);
      for (const item of view.summary) {
        expect(item.resources.chargedUnits).toEqual({ value: null, coverage: "unavailable" });
        expect(item.resources.chargedUnitsPerAgent).toMatchObject({ count: 0, missing: 0, mean: null, total: null });
      }
    }
  });

  it("accepts the root JSON Pointer and does not substitute another field after an explicit selection loses its intersection", async () => {
    const root = await comparisonOf(
      projectFacts("left", { type: "number" }, [{ dataId: DATA_1, results: [0] }]),
      projectFacts("right", { type: "integer" }, [{ dataId: DATA_1, results: [2] }]),
    ).getComparison({ projectIds: PROJECT_IDS, jsonPointer: "" });
    expect(root.selectedField).toMatchObject({ jsonPointer: "", title: "$", dataCount: 1 });
    expect(root.summary.map((item) => item.score?.numeric?.mean)).toEqual([0, 2]);
    const schema: EvaluationOutputSchema = {
      type: "object", properties: { score: { type: ["number", "null"] }, passed: { type: "boolean" } },
    };
    let left = projectFacts("left", schema, [{ dataId: DATA_1, results: [{ score: 0, passed: true }] }]);
    const right = projectFacts("right", schema, [{ dataId: DATA_1, results: [{ score: 1, passed: false }] }]);
    const comparison = createProjectComparison({ source: { read: async () => [left, right] } });
    expect((await comparison.getComparison({ projectIds: PROJECT_IDS })).selectedField?.jsonPointer).toBe("/score");
    left = projectFacts("left", schema, [{ dataId: DATA_1, results: [{ score: null, passed: true }] }]);
    const explicit = await comparison.getComparison({ projectIds: PROJECT_IDS, jsonPointer: "/score" });
    expect(explicit.fields.map((field) => field.jsonPointer)).toEqual(["/passed"]);
    expect(explicit).toMatchObject({ selectedField: null, datasets: [], rows: [] });
    expect((await comparison.getComparison({ projectIds: PROJECT_IDS })).selectedField?.jsonPointer).toBe("/passed");
  });

  it("keeps numeric enum distributions distinct even when their numeric means coincide", async () => {
    const schema: EvaluationOutputSchema = {
      type: "object", properties: { ratings: { type: "array", items: { enum: [0, 1, 2] } } },
    };
    const view = await comparisonOf(
      projectFacts("left", schema, [{ dataId: DATA_1, results: [{ ratings: [0, 2] }] }]),
      projectFacts("right", schema, [{ dataId: DATA_1, results: [{ ratings: [1, 1] }] }]),
    ).getComparison({ projectIds: PROJECT_IDS });
    expect(view.rows[0]).toMatchObject({ spread: 0, different: true });
    expect(view.summary.map((item) => item.score?.numeric?.mean)).toEqual([1, 1]);
  });

  it("is symmetric across three Projects regardless of source order and does not mistake different numeric N for a mean difference", async () => {
    const left = projectFacts("left", NUMERIC_SCHEMA, [
      { dataId: DATA_1, results: [{ score: 0 }, { score: 2 }] }, { dataId: DATA_2, results: [{ score: 99 }] },
    ]);
    const right = projectFacts("right", NUMERIC_SCHEMA, [
      { dataId: DATA_1, results: [{ score: 1 }] }, { dataId: DATA_2, results: [{ score: 100 }] },
    ]);
    const third = projectFacts("third", NUMERIC_SCHEMA, [{ dataId: DATA_1, results: [{ score: -5 }] }]);
    const comparison = comparisonOf(third, right, left);
    const equal = await comparisonOf(right, left).getComparison({ projectIds: PROJECT_IDS });
    expect(equal.rows[0]).toMatchObject({ spread: 0, different: false });
    const forward = await comparison.getComparison({ projectIds: [...PROJECT_IDS, "third"] });
    const reversed = await comparison.getComparison({ projectIds: ["third", ...PROJECT_IDS.toReversed()] });
    expect(forward.fields).toEqual(reversed.fields);
    expect(forward.rows.map((row) => [row.dataId, row.spread, row.different])).toEqual([[DATA_1, 6, true]]);
    expect(reversed.rows.map((row) => [row.dataId, row.spread, row.different])).toEqual([[DATA_1, 6, true]]);
    expect(reversed.summary.map((item) => [item.projectId, item.score?.numeric?.mean])).toEqual([["third", -5], ["right", 1], ["left", 1]]);
  });

  it("keeps query and source snapshots detached from returned values and from a mutating source", async () => {
    const left = projectFacts("left", NUMERIC_SCHEMA, [{ dataId: DATA_1, results: [{ score: 0 }] }]);
    const right = projectFacts("right", NUMERIC_SCHEMA, [{ dataId: DATA_1, results: [{ score: 1 }] }]);
    const original = structuredClone([left, right]);
    const query = { projectIds: ["left", "right"] };
    const comparison = createProjectComparison({ source: { read: async (ids) => {
      (ids as string[])[0] = "changed";
      return [left, right];
    } } });
    const view = await comparison.getComparison(query);
    Object.assign(view.rows[0]!.data, { userPrompt: "Changed result" });
    Object.assign(view.projects[0]!.project, { name: "Changed result" });
    expect(query).toEqual({ projectIds: ["left", "right"] });
    expect([left, right]).toEqual(original);
    const fresh = await comparison.getComparison(query);
    expect(fresh.rows[0]!.data.userPrompt).toBe("Build a page");
    expect(fresh.projects[0]!.project.name).toBe("left");
  });

  it("returns every eligible Data row for application pagination while keeping the whole-range summary authoritative", async () => {
    const cases = Array.from({ length: 25 }, (_, index) => ({
      dataId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, results: [{ score: index }],
    }));
    const view = await comparisonOf(
      projectFacts("left", NUMERIC_SCHEMA, cases), projectFacts("right", NUMERIC_SCHEMA, cases),
    ).getComparison({ projectIds: PROJECT_IDS });
    expect(view.rows).toHaveLength(25);
    expect(view.rows[24]!.dataId).toBe("10000000-0000-4000-8000-000000000025");
    expect(view.summary.map((item) => [item.dataCount, item.samplingCount, item.score?.numeric?.count, item.score?.numeric?.total, item.score?.numeric?.mean]))
      .toEqual([[25, 25, 25, 300, 12], [25, 25, 25, 300, 12]]);
  });
});
