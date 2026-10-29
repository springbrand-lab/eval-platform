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
        evaluationOutputs: { fields: { items: [{ jsonPointer: "/score", numeric: { mean: 8 } }] } } } });
    expect(result).not.toHaveProperty("runId");
    expect(JSON.stringify(result)).not.toMatch(/private Subject prompt|private raw resource snapshot|ownerUserId/u);
    const invalid = await (await app.call("get_metrics", {
      projectId: project.projectId, scope: "sampling", samplingId: "sampling-1",
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
    expect(result).toMatchObject({ summary: { counts: { samplings: 1, evaluations: 1 },
      evaluationOutputs: { fields: { items: [{ jsonPointer: "/score", numeric: { mean: 8 } }] } } },
    projectSamples: { pageSize: 1, total: 2, items: [{ projectSampleId: "sample-1", currentSamplingCount: 1 }] } });
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
      evaluations: { items: [{ evaluationId: "evaluation-1", validation: { status: "valid" } }] } });
    expect(JSON.stringify(sampling)).not.toContain("private explanation");
    expect(JSON.stringify(sampling)).not.toContain("private Subject prompt");
  });
});
