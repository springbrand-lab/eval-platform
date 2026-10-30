import { createHash } from "node:crypto";
import { MetricsEntityNotFoundError } from "@eval-platform/eval-metrics";
import { describe, expect, it } from "vitest";
import type { JsonChunk } from "./common.js";
import { detail, summary } from "./metrics-fixture.js";
import { DATASET, OWNER, project, run, setupManagement, toolValue } from "./test-fixture.js";

const samplingArgs = { projectId: project.projectId, scope: "sampling", samplingId: "sampling-1" } as const;
const chosen = { ...samplingArgs, evaluationId: "evaluation-1" };
type ChosenResult = { evaluationResult: {
  evaluationId: string; outputStatus: string | null; validation: { status: string; reason: string };
  contentHash: string | null; sourceRedacted: boolean; rawJsonChunk: JsonChunk | null;
} };
const selected = (value: Record<string, unknown>) => value as unknown as ChosenResult;
function withJson(rawJson: unknown, validation = { status: "valid", reason: "valid" }) {
  const evaluation = detail.evaluations[0]!;
  return { ...detail, evaluations: [{ ...evaluation, output: {
    ...evaluation.output, rawJson, content: JSON.stringify(rawJson), validation,
  } }] };
}
async function errorCode(response: Response) {
  const rpc = await response.json() as { result: { isError: boolean; content: [{ text: string }] } };
  expect(rpc.result.isError).toBe(true);
  return rpc.result.content[0].text;
}

describe("run-scoped management Metrics", () => {
  it("reads the current retained Project summary without requiring or inventing a Run", async () => {
    const app = setupManagement();
    app.services.metrics.getProjectOverview.mockResolvedValueOnce({
      project, summary, runIds: [run.runId],
      datasets: [{ dataset: { datasetId: DATASET, name: "Dataset",
        projectSampleIds: ["sample-1"] }, summary }],
      projectSamples: [{ ...detail.projectSample, samplingIds: ["sampling-1"], summary }],
    });
    const result = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, scope: "project",
    }));
    expect(app.services.metrics.getProjectOverview).toHaveBeenCalledExactlyOnceWith({ projectId: project.projectId });
    expect(result).toMatchObject({ runScope: "project_current",
      summary: { counts: { samplings: 1, evaluations: 1 },
        executionAgent: { tokens: { total: { value: 50, coverage: "complete" } },
          cacheHitRate: { value: 0, coverage: "complete" },
          costs: { chargedUnits: { value: 3, coverage: "partial" } },
          toolSuccessRate: { value: 0.5, coverage: "complete" } },
        evaluationAgents: { coverage: "partial", tokens: { total: { value: 20, coverage: "partial" } },
          costs: { chargedUnits: { value: 1, coverage: "complete" } },
          cacheHitRate: { value: null, coverage: "unavailable" },
          toolSuccessRate: { value: null, coverage: "unavailable" } },
        evaluationOutputs: { fields: { items: [{ jsonPointer: "/score", numeric: { mean: 8 } }] } } } });
    expect(result).toMatchObject({ summary: {
      executionAgent: { byTool: { page: 1, pageSize: 2, total: 3, items: [
        { toolName: null, count: { value: null, coverage: "partial" }, coverage: "partial", unknown: 1,
          toolSuccessRate: { value: null, coverage: "partial" } },
        { toolName: "browser", count: { value: 2, coverage: "complete" },
          completed: 1, failed: 1, cancelled: 0, inProgress: 0, unknown: 0,
          toolSuccessRate: { value: 0.5, coverage: "complete" } },
      ] } },
      evaluationAgents: { byTool: { total: 1, items: [
        { toolName: "evaluator_tool", count: { value: null, coverage: "unavailable" }, unknown: 1,
          toolSuccessRate: { value: null, coverage: "unavailable" } },
      ] } },
    } });
    expect(result).toMatchObject({ projectSamples: { items: [{
      projectSampleId: "sample-1", samplingIds: { page: 1, total: 1, items: ["sampling-1"] },
    }] } });
    expect(result).not.toHaveProperty("runId");
    expect(JSON.stringify(result)).not.toMatch(/private Subject prompt|private raw resource snapshot|private Tool arguments|ownerUserId/u);
    const invalid = await (await app.call("get_metrics", {
      projectId: project.projectId, scope: "sampling", samplingId: "sampling-1", datasetId: DATASET,
    })).json();
    expect(invalid).toMatchObject({ result: { isError: true } });
    expect(app.services.metrics.getSamplingDetail).not.toHaveBeenCalled();
  });

  it("uses exactly the owned Run and existing Project summary; pages fixed hierarchy without input data", async () => {
    const app = setupManagement();
    app.services.metrics.getProjectOverview.mockResolvedValueOnce({
      project, summary,
      datasets: [{ dataset: { datasetId: DATASET, name: "Dataset",
        projectSampleIds: ["sample-1", "sample-2"] }, summary }],
      projectSamples: [
        { ...detail.projectSample, samplingIds: ["sampling-1"], summary },
        { ...detail.projectSample, projectSampleId: "sample-2", samplingIds: [], summary },
      ],
    });
    const result = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, runId: run.runId, scope: "project", pageSize: 1,
    }));
    expect(app.services.projectRuns.readRun).not.toHaveBeenCalled();
    expect(app.services.metrics.getProjectOverview).toHaveBeenCalledExactlyOnceWith({
      projectId: project.projectId, runIds: [run.runId],
    });
    expect(result).toMatchObject({ runScope: "exact_run", runId: run.runId,
      summary: { counts: { samplings: 1, evaluations: 1 },
      evaluationOutputs: { fields: { items: [{ jsonPointer: "/score", numeric: { mean: 8 } }] } } },
      projectSamples: { pageSize: 1, total: 2, items: [{ projectSampleId: "sample-1", currentSamplingCount: 1,
        samplingIds: { items: ["sampling-1"], total: 1 } }] } });
    for (const secret of ["private Subject prompt", "private raw resource snapshot", "private schema description", "ownerUserId"]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it("indexes already-computed per-ProjectSample numeric scores, including missing evaluations, without reading each Sample", async () => {
    const app = setupManagement();
    const rows = Array.from({ length: 34 }, (_, index) => {
      const score = index === 33 ? null : index < 6 ? 2 : 8;
      const sampleSummary = { ...summary,
        evaluation: { ...summary.evaluation, records: score === null ? 0 : 1,
          statuses: { ...summary.evaluation.statuses, succeeded: score === null ? 0 : 1 } },
        evaluationOutputs: { ...summary.evaluationOutputs, evaluations: score === null ? 0 : 1,
          validation: { valid: score === null ? 0 : 1 },
          fields: [{ ...summary.evaluationOutputs.fields[0]!,
            numeric: { ...summary.evaluationOutputs.fields[0]!.numeric!, mean: score, count: score === null ? 0 : 1 },
            observationCount: score === null ? 0 : 1, contributingEvaluationCount: score === null ? 0 : 1,
            coverage: score === null ? "unavailable" : "complete" }] },
      };
      return { ...detail.projectSample, projectSampleId: `sample-${index}`, samplingIds: score === null ? [] : [`sampling-${index}`],
        summary: sampleSummary };
    });
    app.services.metrics.getProjectOverview.mockResolvedValue({
      project, summary, datasets: [], projectSamples: rows,
    });
    app.services.metrics.getDatasetOverview.mockResolvedValue({
      project, summary, dataset: { datasetId: DATASET, name: "Dataset" }, projectSamples: rows.slice(0, 2),
    });
    const low: string[] = [];
    for (let page = 1; page <= 12; page++) {
      const result = await toolValue(await app.call("get_metrics", {
        projectId: project.projectId, runId: run.runId, scope: "project", page, pageSize: 3,
      })) as { projectSamples: { total: number; items: Array<{ projectSampleId: string; scoreIndex: {
        evaluations: number; statuses: Record<string, number>; validation: Record<string, number>;
        field: { jsonPointer: string; value: number | null; coverage: string;
          observationCount: number; contributingEvaluationCount: number; missingEvaluationCount: number } | null;
      } }> } };
      expect(result.projectSamples.total).toBe(34);
      for (const { projectSampleId, scoreIndex } of result.projectSamples.items) {
        if (scoreIndex.field?.value !== null && scoreIndex.field?.value !== undefined && scoreIndex.field.value < 5) {
          low.push(projectSampleId);
        }
        if (projectSampleId === "sample-33") {
          expect(scoreIndex).toMatchObject({ evaluations: 0, statuses: { succeeded: 0 },
            validation: { valid: 0 }, field: { jsonPointer: "/score", value: null, coverage: "unavailable",
              observationCount: 0, contributingEvaluationCount: 0 } });
        }
      }
    }
    expect(low).toEqual(Array.from({ length: 6 }, (_, index) => `sample-${index}`));
    expect(app.services.metrics.getSampleOverview).not.toHaveBeenCalled();
    expect(app.services.metrics.getSamplingDetail).not.toHaveBeenCalled();
    expect(app.services.metrics.getProjectOverview).toHaveBeenCalledWith({ projectId: project.projectId, runIds: [run.runId] });
    const dataset = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, scope: "dataset", datasetId: DATASET, pageSize: 1,
    }));
    expect(dataset).toMatchObject({ runScope: "project_current",
      projectSamples: { items: [{ scoreIndex: { evaluations: 1, statuses: { succeeded: 1 },
        field: { jsonPointer: "/score", value: 2, coverage: "complete",
          observationCount: 1, contributingEvaluationCount: 1, missingEvaluationCount: 0 } } }] } });
    expect(app.services.metrics.getDatasetOverview).toHaveBeenCalledExactlyOnceWith({
      projectId: project.projectId, datasetId: DATASET,
    });
  });

  it("selects a different numeric Schema pointer without confusing it with a Tool rate or a single-Evaluation score", async () => {
    const app = setupManagement();
    const alternate = { ...summary.evaluationOutputs.fields[0]!, jsonPointer: "/quality",
      numeric: { ...summary.evaluationOutputs.fields[0]!.numeric!, mean: 0.75, count: 2 },
      observationCount: 2, contributingEvaluationCount: 2, missingEvaluationCount: 1, coverage: "partial" };
    const sampleSummary = { ...summary, evaluation: { ...summary.evaluation,
      records: 3, statuses: { ...summary.evaluation.statuses, succeeded: 2, failed: 1 } },
    evaluationOutputs: { ...summary.evaluationOutputs, evaluations: 3,
      validation: { valid: 2, invalid: 1 }, fields: [...summary.evaluationOutputs.fields, alternate] } };
    app.services.metrics.getProjectOverview.mockResolvedValue({ project, summary,
      datasets: [], projectSamples: [{ ...detail.projectSample, samplingIds: ["sampling-1"], summary: sampleSummary }] });
    const indexed = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, scope: "project", numericPointer: "/quality", pageSize: 1,
    }));
    expect(indexed).toMatchObject({ projectSamples: { items: [{ scoreIndex: {
      evaluations: 3, statuses: { succeeded: 2, failed: 1 }, validation: { valid: 2, invalid: 1 },
      field: { jsonPointer: "/quality", value: 0.75, coverage: "partial", observationCount: 2,
        contributingEvaluationCount: 2, missingEvaluationCount: 1 },
    } }] } });
    app.services.metrics.getProjectOverview.mockResolvedValueOnce({ project, summary,
      datasets: [], projectSamples: [{ ...detail.projectSample, samplingIds: ["sampling-1"],
        summary: { ...sampleSummary, evaluationOutputs: { ...sampleSummary.evaluationOutputs, fields: [alternate] } } }] });
    expect(await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, scope: "project", pageSize: 1,
    }))).toMatchObject({ projectSamples: { items: [{ scoreIndex: {
      evaluations: 3, field: null,
    } }] } }); // Do not silently reinterpret /quality as /score.
    expect(await errorCode(await app.call("get_metrics", {
      projectId: project.projectId, scope: "sample", projectSampleId: "sample-1", numericPointer: "/quality",
    }))).toContain("REQUEST_INVALID_INPUT");
    expect(app.services.metrics.getSampleOverview).not.toHaveBeenCalled();
  });

  it("does not reveal numeric credentials through either the sample index or the usual aggregate field", async () => {
    const app = setupManagement();
    const token = 123456789;
    const tokenField = { ...summary.evaluationOutputs.fields[0]!, jsonPointer: "/token",
      numeric: { ...summary.evaluationOutputs.fields[0]!.numeric!, mean: token, min: token, max: token, total: token },
      distribution: [{ value: token, count: 1, share: 1, evaluations: 1 }] };
    const secretSummary = { ...summary, evaluationOutputs: { ...summary.evaluationOutputs, fields: [tokenField] } };
    app.services.metrics.getProjectOverview.mockResolvedValueOnce({
      project, summary: secretSummary, datasets: [],
      projectSamples: [{ ...detail.projectSample, samplingIds: ["sampling-1"], summary: secretSummary }],
    });
    const indexed = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, scope: "project", numericPointer: "/token", pageSize: 1,
    }));
    expect(indexed).toMatchObject({ summary: { evaluationOutputs: { fields: { items: [{
      jsonPointer: "/token", numeric: null, numericRedacted: true, sourceRedacted: true,
      distribution: [{ value: "[REDACTED: sensitive source content]", sourceRedacted: true }],
    }] } } }, projectSamples: { items: [{ scoreIndex: { field: {
      jsonPointer: "/token", value: null, sourceRedacted: true, coverage: "complete",
    } } }] } });
    expect(JSON.stringify(indexed)).not.toContain(String(token));
  });

  it("relies on the existing owner/Project/Run-scoped Metrics reader and rejects malformed scope IDs", async () => {
    const app = setupManagement();
    app.services.metrics.getProjectOverview.mockRejectedValueOnce(
      new MetricsEntityNotFoundError("project", "foreign-project"));
    const foreign = await (await app.call("get_metrics", {
      projectId: "foreign-project", runId: run.runId, scope: "project",
    })).json();
    expect(foreign).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("PROJECT_NOT_FOUND") }] } });
    const invalid = await (await app.call("get_metrics", {
      projectId: project.projectId, runId: run.runId, scope: "sampling", datasetId: DATASET,
    })).json();
    expect(invalid).toMatchObject({ result: { isError: true } });
    expect(app.services.metrics.getProjectOverview).toHaveBeenCalledTimes(1);
    expect(app.services.metrics.getSamplingDetail).not.toHaveBeenCalled();
  });

  it("reuses Dataset, Sample and Sampling queries instead of calculating a second score", async () => {
    const app = setupManagement();
    app.services.metrics.getDatasetOverview.mockResolvedValueOnce({
      project, summary, dataset: { datasetId: DATASET, name: "Dataset" },
      projectSamples: [{ ...detail.projectSample, summary }],
    });
    app.services.metrics.getSampleOverview.mockResolvedValueOnce({
      project, summary, projectSample: detail.projectSample,
      samplings: [{ samplingId: "sampling-1", execution: { status: "succeeded" }, summary,
        artifactCount: 1, hasTrajectory: true }],
    });
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(detail);

    await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, runId: run.runId, scope: "dataset", datasetId: DATASET,
    }));
    await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, runId: run.runId, scope: "sample", projectSampleId: "sample-1",
    }));
    const sampling = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, runId: run.runId, scope: "sampling", samplingId: "sampling-1",
    }));
    expect(app.services.metrics.getDatasetOverview).toHaveBeenCalledWith({
      projectId: project.projectId, runIds: [run.runId], datasetId: DATASET,
    });
    expect(app.services.metrics.getSampleOverview).toHaveBeenCalledWith({
      projectId: project.projectId, runIds: [run.runId], projectSampleId: "sample-1",
    });
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledWith({
      projectId: project.projectId, runIds: [run.runId], samplingId: "sampling-1",
    });
    expect(sampling).toMatchObject({ summary: { evaluationOutputs: { fields: { items: [{ numeric: { mean: 8 } }] } } },
      runScope: "exact_run", runId: run.runId,
      evaluations: { items: [{ evaluationId: "evaluation-1", validation: { status: "valid" } }] } });
    expect(JSON.stringify(sampling)).not.toContain("private explanation");
    expect(JSON.stringify(sampling)).not.toContain("private Subject prompt");
  });

  it("pages current ProjectSample → Sampling → Evaluation identities without selecting a Run", async () => {
    const app = setupManagement();
    app.services.metrics.getDatasetOverview.mockResolvedValueOnce({
      project, summary, dataset: { datasetId: DATASET, name: "Dataset" },
      projectSamples: [{ ...detail.projectSample, summary }],
    });
    app.services.metrics.getSampleOverview.mockResolvedValue({
      project, summary, projectSample: detail.projectSample,
      samplings: ["sampling-1", "sampling-2"].map((samplingId) => ({
        samplingId, execution: { status: "succeeded" }, summary, artifactCount: 0, hasTrajectory: false,
      })),
    });
    app.services.metrics.getSamplingDetail.mockResolvedValue({
      ...detail, evaluations: [
        detail.evaluations[0]!,
        { ...detail.evaluations[0]!, record: { ...detail.evaluations[0]!.record, evaluationId: "evaluation-2" },
          agent: { ...detail.evaluations[0]!.agent, evaluationId: "evaluation-2" },
          output: { ...detail.evaluations[0]!.output, evaluationId: "evaluation-2" } },
      ],
    });
    const dataset = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, scope: "dataset", datasetId: DATASET,
    }));
    const sample = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, scope: "sample", projectSampleId: "sample-1", page: 2, pageSize: 1,
    }));
    const sampling = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, scope: "sampling", samplingId: "sampling-1", page: 2, pageSize: 1,
    }));
    expect(app.services.metrics.getDatasetOverview).toHaveBeenCalledExactlyOnceWith({
      projectId: project.projectId, datasetId: DATASET,
    });
    expect(app.services.metrics.getSampleOverview).toHaveBeenCalledExactlyOnceWith({
      projectId: project.projectId, projectSampleId: "sample-1",
    });
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledExactlyOnceWith({
      projectId: project.projectId, samplingId: "sampling-1",
    });
    expect(app.services.projectRuns.readRun).not.toHaveBeenCalled();
    expect(dataset).toMatchObject({ runScope: "project_current", projectSamples: { items: [{ projectSampleId: "sample-1" }] } });
    expect(sample).toMatchObject({ runScope: "project_current",
      samplings: { page: 2, pageSize: 1, total: 2, items: [{ samplingId: "sampling-2" }] } });
    expect(sampling).toMatchObject({ runScope: "project_current",
      summary: { executionAgent: { toolSuccessRate: { value: 0.5, coverage: "complete" } },
        evaluationAgents: { toolSuccessRate: { value: null, coverage: "unavailable" } } },
      evaluations: { page: 2, pageSize: 1, total: 2, items: [{ evaluationId: "evaluation-2" }] } });
    for (const value of [dataset, sample, sampling]) {
      expect(value).not.toHaveProperty("runId");
      expect(JSON.stringify(value)).not.toMatch(/private Subject prompt|private raw resource snapshot|ownerUserId/u);
    }
  });

  it("pages source-backed native per-Tool rates for both roles without mixing coverage", async () => {
    const app = setupManagement();
    app.services.metrics.getProjectOverview.mockResolvedValue({
      project, summary, datasets: [], projectSamples: [],
    });
    const page = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, scope: "project", toolPage: 2, toolPageSize: 1,
    }));
    expect(page).toMatchObject({ summary: {
      executionAgent: { toolSuccessRate: { value: 0.5, coverage: "complete" },
        byTool: { page: 2, pageSize: 1, total: 3, items: [
          { toolName: "browser", count: { value: 2, coverage: "complete" },
            completed: 1, failed: 1, cancelled: 0, inProgress: 0, unknown: 0, coverage: "complete",
            toolSuccessRate: { value: 0.5, coverage: "complete" } },
        ] } },
      evaluationAgents: { toolSuccessRate: { value: null, coverage: "unavailable" },
        byTool: { page: 2, pageSize: 1, total: 1, items: [] } },
    } });
    expect(JSON.stringify(page)).not.toMatch(/private Tool arguments|inputLength|outputLength|toolArguments|toolResult/u);
    expect(await errorCode(await app.call("get_metrics", {
      projectId: project.projectId, scope: "project", toolPageSize: 6,
    }))).toContain("REQUEST_INVALID_INPUT");
    expect(app.services.metrics.getProjectOverview).toHaveBeenCalledTimes(1);
  });

  it("keeps per-role numeric rates, cancelled calls and unknown/in-progress coverage from Metrics", async () => {
    const app = setupManagement();
    const reviewerRate = { value: 0.25, coverage: "partial" } as const;
    app.services.metrics.getProjectOverview.mockResolvedValue({
      project, datasets: [], projectSamples: [],
      summary: { ...summary, evaluationAgents: { ...summary.evaluationAgents,
        trajectory: { ...summary.evaluationAgents.trajectory, toolSuccessRate: reviewerRate, byTool: [{
          toolName: "review", count: { value: 6, coverage: "partial" },
          completed: 1, failed: 2, cancelled: 1, inProgress: 1, unknown: 1, toolSuccessRate: reviewerRate,
        }] },
      } },
    });
    const first = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, scope: "project", toolPageSize: 1,
    }));
    expect(first).toMatchObject({ summary: {
      executionAgent: { byTool: { total: 3, items: [{
        toolName: null, toolSuccessRate: { value: null, coverage: "partial" },
      }] } },
      evaluationAgents: { toolSuccessRate: reviewerRate, byTool: {
        total: 1, items: [{ toolName: "review", count: { value: 6, coverage: "partial" },
          completed: 1, failed: 2, cancelled: 1, inProgress: 1, unknown: 1,
          toolSuccessRate: reviewerRate }],
      } },
    } });
    const last = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, scope: "project", toolPage: 3, toolPageSize: 1,
    }));
    expect(last).toMatchObject({ summary: {
      executionAgent: { byTool: { page: 3, total: 3, items: [{
        toolName: "search", completed: 0, cancelled: 1,
        toolSuccessRate: { value: 0, coverage: "partial" },
      }] } },
      evaluationAgents: { byTool: { page: 3, total: 1, items: [] } },
    } });
  });

  it("returns a detailed Project page beyond the former 4,800-byte ceiling", async () => {
    const app = setupManagement();
    const fields = Array.from({ length: 20 }, (_, index) => ({
      ...summary.evaluationOutputs.fields[0]!, jsonPointer: `/score${index}`, title: `Score ${index}`,
    }));
    app.services.metrics.getProjectOverview.mockResolvedValue({
      project, summary: { ...summary, evaluationOutputs: { ...summary.evaluationOutputs, fields } },
      datasets: [], projectSamples: [],
    });
    const detailed = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, scope: "project", pageSize: 20,
    }));
    expect(Buffer.byteLength(JSON.stringify(detailed), "utf8")).toBeGreaterThan(4_800);
    expect(detailed).toMatchObject({ summary: {
      evaluationOutputs: { fields: { pageSize: 20, total: 20, items: expect.arrayContaining([
        expect.objectContaining({ jsonPointer: "/score19" }),
      ]) } },
    } });
    const smaller = await toolValue(await app.call("get_metrics", {
      projectId: project.projectId, scope: "project", pageSize: 1,
    }));
    expect(smaller).toMatchObject({ summary: {
      counts: { samplings: 1, evaluations: 1 },
      evaluationOutputs: { fields: { pageSize: 1, total: 20, items: [{ jsonPointer: "/score0" }] } },
    } });
  });

  it("marks unsafe native Tool and Schema-display labels without exposing a raw URL or key", async () => {
    const app = setupManagement();
    const withSensitive = { ...summary,
      executionAgent: { ...summary.executionAgent, trajectory: { ...summary.executionAgent.trajectory,
        byTool: [{ ...summary.executionAgent.trajectory.byTool[1]!, toolName: "https://private.example/tool" }] } },
      evaluationOutputs: { ...summary.evaluationOutputs, fields: [
        { ...summary.evaluationOutputs.fields[0]!, title: "https://private.example/field",
          distribution: [{ value: "Bearer very-private-token", count: 1, share: 1 }] },
      ] },
    };
    app.services.metrics.getProjectOverview.mockResolvedValueOnce({
      project, summary: withSensitive, datasets: [], projectSamples: [],
    });
    const value = await toolValue(await app.call("get_metrics", { projectId: project.projectId, scope: "project" }));
    expect(value).toMatchObject({ summary: {
      executionAgent: { byTool: { items: [{ toolName: "[REDACTED: sensitive source content]",
        sourceRedacted: true, count: { value: 2 } }] } },
      evaluationOutputs: { fields: { items: [{ title: "[REDACTED: sensitive source content]",
        sourceRedacted: true, distribution: [{ value: "[REDACTED: sensitive source content]", sourceRedacted: true }] }] } },
    } });
    expect(JSON.stringify(value)).not.toMatch(/https:|very-private-token/u);
  });

  it("returns the selected Evaluator's complete parsed nonnumeric JSON, not a score excerpt or another Evaluation", async () => {
    const app = setupManagement();
    const rawJson = { score: 8, reason: "Helpful explanation", passed: true, absent: null,
      checks: [{ name: "first", passed: false, detail: { errors: ["one", "two"] } }],
      metadata: { tags: ["alpha", "beta"], empty: {} } };
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(withJson(rawJson));
    const value = await toolValue(await app.call("get_metrics", chosen));
    const result = selected(value).evaluationResult;
    expect(value).toMatchObject({ scope: "sampling", runScope: "project_current",
      projectSample: { projectSampleId: "sample-1" }, sampling: { samplingId: "sampling-1" } });
    expect(value).not.toHaveProperty("summary");
    expect(value).not.toHaveProperty("evaluations");
    expect(result).toMatchObject({ evaluationId: "evaluation-1", outputStatus: "succeeded",
      validation: { status: "valid", reason: "valid" }, sourceRedacted: false,
      contentHash: "b".repeat(64) });
    expect(result.rawJsonChunk!.nextOffset).toBeNull();
    expect(JSON.parse(result.rawJsonChunk!.text)).toEqual(rawJson);
    expect(result.rawJsonChunk!.sha256).toBe(createHash("sha256").update(JSON.stringify(rawJson)).digest("hex"));
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledExactlyOnceWith({
      projectId: project.projectId, samplingId: "sampling-1",
    });
    expect(app.services.projectRuns.readRun).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).not.toMatch(/private Subject prompt|private Tool arguments|evaluator-chat|signed\.test/u);
  });

  it("selects a later Evaluation after ID paging without returning the first Evaluator's result", async () => {
    const app = setupManagement();
    const first = detail.evaluations[0]!;
    const secondJson = { reason: "Second evaluator", passed: false, detail: [null, "independent"] };
    const second = { ...first,
      record: { ...first.record, evaluationId: "evaluation-2" },
      agent: { ...first.agent, evaluationId: "evaluation-2" },
      output: { ...first.output, evaluationId: "evaluation-2", rawJson: secondJson, content: JSON.stringify(secondJson) },
    };
    app.services.metrics.getSamplingDetail.mockResolvedValue({ ...detail, evaluations: [first, second] });
    const page = await toolValue(await app.call("get_metrics", { ...samplingArgs, page: 2, pageSize: 1 }));
    expect(page).toMatchObject({ evaluations: { total: 2, page: 2, items: [{ evaluationId: "evaluation-2" }] } });
    expect(JSON.stringify(page)).not.toContain("Second evaluator");
    const selectedSecond = selected(await toolValue(await app.call("get_metrics", {
      ...samplingArgs, evaluationId: "evaluation-2",
    }))).evaluationResult;
    expect(selectedSecond.evaluationId).toBe("evaluation-2");
    expect(JSON.parse(selectedSecond.rawJsonChunk!.text)).toEqual(secondJson);
    expect(selectedSecond.rawJsonChunk!.text).not.toContain("private explanation");
    expect(app.services.projectRuns.readRun).not.toHaveBeenCalled();
  });

  it("continues a long UTF-8 result on code-point byte boundaries with one stable full-document digest", async () => {
    const app = setupManagement();
    const rawJson = { reason: "评估🧪".repeat(1_200), passed: false, nested: [{ accepted: null }] };
    app.services.metrics.getSamplingDetail.mockResolvedValue(withJson(rawJson));
    const chunks: JsonChunk[] = [];
    let offset = 0;
    do {
      const response = await app.call("get_metrics", { ...chosen, resultOffset: offset });
      const rpc = await response.json() as { result: { content: [{ text: string }] } };
      expect(rpc.result.content[0].text.length).toBeLessThan(5_000);
      const chunk = selected(JSON.parse(rpc.result.content[0].text) as Record<string, unknown>).evaluationResult.rawJsonChunk!;
      expect(chunk.offset).toBe(offset);
      expect(Buffer.byteLength(chunk.text, "utf8")).toBeLessThanOrEqual(2_048);
      expect(chunk.text).not.toContain("\ufffd");
      chunks.push(chunk);
      offset = chunk.nextOffset ?? 0;
    } while (offset !== 0 && chunks.length < 30);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.at(-1)!.nextOffset).toBeNull();
    const canonical = JSON.stringify(rawJson);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(canonical);
    expect(chunks.every((chunk) => chunk.sha256 === chunks[0]!.sha256
      && chunk.totalBytes === Buffer.byteLength(canonical, "utf8"))).toBe(true);
    expect(chunks[0]!.sha256).toBe(createHash("sha256").update(canonical).digest("hex"));
    const insideCodePoint = Buffer.from(canonical).indexOf(Buffer.from("评")) + 1;
    expect(await errorCode(await app.call("get_metrics", { ...chosen, resultOffset: insideCodePoint })))
      .toContain("REQUEST_INVALID_INPUT");
    expect(await errorCode(await app.call("get_metrics", {
      ...chosen, resultOffset: Buffer.byteLength(canonical, "utf8"),
    }))).toContain("REQUEST_INVALID_INPUT");
  });

  it("adapts escape-heavy JSON chunks to Takt's budget, including long opaque IDs", async () => {
    const app = setupManagement();
    const long = "id-" + "a".repeat(500);
    const large = { reason: '"\\'.repeat(3_000), note: "Complete, not an excerpt" };
    app.services.metrics.getSamplingDetail.mockResolvedValue({
      ...withJson(large),
      project: { ...project, projectId: long },
      projectSample: { ...detail.projectSample, projectId: long, projectSampleId: long },
      sampling: { ...detail.sampling, projectId: long, projectSampleId: long, samplingId: long },
      subject: { ...detail.subject, samplingId: long },
      evaluations: [{ ...detail.evaluations[0]!,
        record: { ...detail.evaluations[0]!.record, samplingId: long, evaluationId: long },
        agent: { ...detail.evaluations[0]!.agent, samplingId: long, evaluationId: long },
        output: { ...detail.evaluations[0]!.output, samplingId: long, evaluationId: long,
          rawJson: large, content: JSON.stringify(large) },
      }],
    });
    const args = { projectId: long, scope: "sampling", samplingId: long, evaluationId: long };
    const chunks: JsonChunk[] = [];
    let offset = 0;
    do {
      const rpc = await (await app.call("get_metrics", { ...args, resultOffset: offset })).json() as {
        result: { isError?: boolean; content: [{ text: string }] };
      };
      expect(rpc.result.isError).not.toBe(true);
      expect(rpc.result.content[0].text.length).toBeLessThanOrEqual(4_800);
      expect(Buffer.byteLength(rpc.result.content[0].text, "utf8")).toBeLessThanOrEqual(4_800);
      const chunk = selected(JSON.parse(rpc.result.content[0].text) as Record<string, unknown>)
        .evaluationResult.rawJsonChunk!;
      expect(chunk.offset).toBe(offset);
      expect(Buffer.byteLength(chunk.text, "utf8")).toBeLessThanOrEqual(2_048);
      chunks.push(chunk);
      offset = chunk.nextOffset ?? 0;
    } while (offset !== 0 && chunks.length < 40);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.at(-1)!.nextOffset).toBeNull();
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(JSON.stringify(large));
    expect(chunks.every((chunk) => chunk.sha256 === chunks[0]!.sha256
      && chunk.totalBytes === Buffer.byteLength(JSON.stringify(large), "utf8"))).toBe(true);
  });

  it("distinguishes valid JSON null/false from absent, invalid JSON and Schema-mismatched parsed text", async () => {
    const app = setupManagement();
    for (const [raw, expected] of [[null, "null"], [false, "false"], [["reason", null], '["reason",null]']] as const) {
      app.services.metrics.getSamplingDetail.mockResolvedValueOnce(withJson(raw));
      const output = selected(await toolValue(await app.call("get_metrics", chosen))).evaluationResult;
      expect(output.validation).toEqual({ status: "valid", reason: "valid" });
      expect(output.rawJsonChunk?.text).toBe(expected);
    }
    for (const [raw, reason] of [[{ reason: "parsed without a Schema" }, "no-schema"],
      [null, "invalid-schema"]] as const) {
      app.services.metrics.getSamplingDetail.mockResolvedValueOnce(withJson(raw, { status: "unavailable", reason }));
      const output = selected(await toolValue(await app.call("get_metrics", chosen))).evaluationResult;
      expect(output.validation).toEqual({ status: "unavailable", reason });
      expect(JSON.parse(output.rawJsonChunk!.text)).toEqual(raw);
    }
    const evaluation = detail.evaluations[0]!;
    for (const [validation, content, rawJson, outputStatus] of [
      [{ status: "unavailable", reason: "no-output" }, null, null, null],
      [{ status: "invalid", reason: "invalid-json" }, "{", null, "failed"],
      [{ status: "invalid", reason: "schema-mismatch" }, '{"score":"bad"}', { score: "bad" }, "failed"],
    ] as const) {
      app.services.metrics.getSamplingDetail.mockResolvedValueOnce({ ...detail, evaluations: [{ ...evaluation,
        output: { ...evaluation.output, validation, content, rawJson, outputStatus } }] });
      const output = selected(await toolValue(await app.call("get_metrics", chosen))).evaluationResult;
      expect(output.validation).toEqual(validation);
      expect(output.outputStatus).toBe(outputStatus);
      expect(output.rawJsonChunk?.text ?? null).toBe(validation.reason === "schema-mismatch" ? '{"score":"bad"}' : null);
      expect(output.sourceRedacted).toBe(false);
    }
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce({ ...detail, evaluations: [{ ...evaluation,
      output: { ...evaluation.output, validation: { status: "unavailable", reason: "no-output" },
        content: null, rawJson: null, outputStatus: null } }] });
    expect(await errorCode(await app.call("get_metrics", { ...chosen, resultOffset: 1 })))
      .toContain("REQUEST_INVALID_INPUT");
  });

  it("marks masked URLs, credentials and the frozen private prompt, and hashes only displayed JSON", async () => {
    const app = setupManagement();
    const rawJson = { reason: "Safe reason", accessToken: "secret123",
      proof: "https://private.example/secret", copied: detail.projectSample.data.userPrompt };
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(withJson(rawJson));
    const result = selected(await toolValue(await app.call("get_metrics", chosen))).evaluationResult;
    const display = JSON.parse(result.rawJsonChunk!.text) as Record<string, string>;
    expect(display.reason).toBe("Safe reason");
    expect(result.sourceRedacted).toBe(true);
    for (const field of ["accessToken", "proof", "copied"]) {
      expect(display[field]).toBe("[REDACTED: sensitive source content]");
    }
    expect(result.rawJsonChunk!.sha256).toBe(createHash("sha256").update(result.rawJsonChunk!.text).digest("hex"));
    expect(JSON.stringify(result)).not.toMatch(/secret123|https:|private Subject prompt/u);
    const unsafe = withJson({ "https://unsafe.example": "value" });
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(unsafe);
    expect(selected(await toolValue(await app.call("get_metrics", chosen))).evaluationResult)
      .toMatchObject({ sourceRedacted: true, rawJsonChunk: null });
  });

  it("preserves safe url/token/prompt field names with masked values across every result chunk", async () => {
    const app = setupManagement();
    const rawJson = { url: "https://private.example/result", token: 123456789,
      prompt: { secret: "do not show" }, reason: "Safe reason",
      notes: "A normal explanation. 评估🧪".repeat(200) };
    app.services.metrics.getSamplingDetail.mockResolvedValue(withJson(rawJson));
    const chunks: JsonChunk[] = [];
    let offset = 0;
    do {
      const rpc = await (await app.call("get_metrics", { ...chosen, resultOffset: offset })).json() as {
        result: { isError?: boolean; content: [{ text: string }] };
      };
      expect(rpc.result.isError).not.toBe(true);
      expect(rpc.result.content[0].text).not.toMatch(/https:|private\.example|123456789|do not show/u);
      const part = selected(JSON.parse(rpc.result.content[0].text) as Record<string, unknown>).evaluationResult;
      expect(part.sourceRedacted).toBe(true);
      expect(part.rawJsonChunk!.offset).toBe(offset);
      chunks.push(part.rawJsonChunk!);
      offset = part.rawJsonChunk!.nextOffset ?? 0;
    } while (offset !== 0 && chunks.length < 20);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.at(-1)!.nextOffset).toBeNull();
    const displayed = chunks.map((part) => part.text).join("");
    expect(JSON.parse(displayed)).toEqual({
      url: "[REDACTED: sensitive source content]", token: "[REDACTED: sensitive source content]",
      prompt: "[REDACTED: sensitive source content]", reason: "Safe reason", notes: rawJson.notes,
    });
    expect(chunks.every((part) => part.sha256 === createHash("sha256").update(displayed).digest("hex")
      && part.totalBytes === Buffer.byteLength(displayed, "utf8"))).toBe(true);
  });

  it("masks sensitive null/boolean/array values and withholds a document whose key contains the frozen prompt", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(withJson({
      url: null, token: false, prompt: ["not for display"], reason: "Safe reason",
    }));
    const safe = selected(await toolValue(await app.call("get_metrics", chosen))).evaluationResult;
    expect(safe.sourceRedacted).toBe(true);
    expect(JSON.parse(safe.rawJsonChunk!.text)).toEqual({
      url: "[REDACTED: sensitive source content]", token: "[REDACTED: sensitive source content]",
      prompt: "[REDACTED: sensitive source content]", reason: "Safe reason",
    });
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(withJson({
      reason: "An earlier safe field", [detail.projectSample.data.userPrompt]: "hidden source",
    }));
    const withheld = selected(await toolValue(await app.call("get_metrics", chosen))).evaluationResult;
    expect(withheld).toMatchObject({ rawJsonChunk: null, sourceRedacted: true });
    expect(withheld).not.toHaveProperty("streamRequired");
    expect(JSON.stringify(withheld)).not.toContain(detail.projectSample.data.userPrompt);
  });

  it("rejects incompatible result cursors and foreign, replaced or wrongly bound Evaluations", async () => {
    const app = setupManagement();
    for (const args of [
      { ...samplingArgs, resultOffset: 1 }, { ...chosen, scope: "sample", projectSampleId: "sample-1" },
      { ...chosen, datasetId: DATASET }, { ...chosen, page: 2 }, { ...chosen, toolPage: 2 },
      { ...chosen, resultOffset: -1 }, { ...chosen, resultOffset: 1.5 }, { ...chosen, extra: true },
    ]) {
      expect(await errorCode(await app.call("get_metrics", args))).toContain("REQUEST_INVALID_INPUT");
    }
    expect(app.services.metrics.getSamplingDetail).not.toHaveBeenCalled();
    expect(await errorCode(await app.call("get_metrics", { ...chosen, runId: run.runId, evaluationId: "evaluation-2" })))
      .toContain("EVALUATION_NOT_FOUND");
    expect(app.services.metrics.getSamplingDetail).not.toHaveBeenCalled();
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(withJson({ reason: "selected" }));
    const exact = await toolValue(await app.call("get_metrics", { ...chosen, runId: run.runId }));
    expect(exact).toMatchObject({ runScope: "exact_run", runId: run.runId });
    expect(app.services.projectRuns.readRun).toHaveBeenCalledWith(project.projectId, run.runId);
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledWith({
      projectId: project.projectId, samplingId: "sampling-1", runIds: [run.runId],
    });
    const foreign = [
      { ...detail, project: { ...detail.project, ownerUserId: "foreign" } },
      { ...detail, projectSample: { ...detail.projectSample, projectId: "foreign" } },
      { ...detail, runIds: ["another-run"] },
      { ...detail, sampling: { ...detail.sampling, subjectAgent: { ownerUserId: "foreign" } } },
      { ...detail, subject: { ...detail.subject, chatId: "another-chat" } },
      { ...detail, evaluations: [{ ...detail.evaluations[0]!, record: {
        ...detail.evaluations[0]!.record, samplingId: "another-sampling",
      } }] },
      { ...detail, evaluations: [{ ...detail.evaluations[0]!, agent: {
        ...detail.evaluations[0]!.agent, evaluationId: "another-evaluation",
      } }] },
      { ...detail, evaluations: [{ ...detail.evaluations[0]!, output: {
        ...detail.evaluations[0]!.output, evaluationId: "another-evaluation",
      } }] },
      { ...detail, evaluations: [{ ...detail.evaluations[0]!, agent: {
        ...detail.evaluations[0]!.agent, agentConfigRef: { ownerUserId: "foreign" },
      } }] },
    ];
    for (const view of foreign) {
      app.services.metrics.getSamplingDetail.mockResolvedValueOnce(view);
      expect(await errorCode(await app.call("get_metrics", { ...chosen, runId: run.runId })))
        .toMatch(/SAMPLING_NOT_FOUND|EVALUATION_NOT_FOUND/u);
    }
    expect(detail.project.ownerUserId).toBe(OWNER);
    app.services.metrics.getSamplingDetail.mockRejectedValueOnce(
      new MetricsEntityNotFoundError("sampling", "sampling-1"));
    expect(await errorCode(await app.call("get_metrics", chosen))).toContain("SAMPLING_NOT_FOUND");
  });
});
