import { MetricsEntityNotFoundError } from "@eval-platform/eval-metrics";
import { describe, expect, it } from "vitest";
import { detail, summary } from "./metrics-fixture.js";
import { DATASET, project, run, setupManagement, toolValue } from "./test-fixture.js";

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
    expect(result).toMatchObject({ projectSamples: { items: [{
      projectSampleId: "sample-1", samplingIds: { page: 1, total: 1, items: ["sampling-1"] },
    }] } });
    expect(result).not.toHaveProperty("runId");
    expect(JSON.stringify(result)).not.toMatch(/private Subject prompt|private raw resource snapshot|ownerUserId/u);
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
        { ...detail.evaluations[0]!, record: { ...detail.evaluations[0]!.record, evaluationId: "evaluation-2" } },
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
});
