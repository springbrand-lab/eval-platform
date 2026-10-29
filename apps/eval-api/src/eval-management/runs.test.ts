import { describe, expect, it } from "vitest";
import { AGENT, DATASET, preview, project, run, setupManagement, toolValue } from "./test-fixture.js";

const creation = {
  idempotencyKey: "project-key", name: " New project ", datasets: [{ datasetId: DATASET.toUpperCase() }],
  samplingCount: 2, execution: { userAgentId: AGENT, framework: "sp", executionConcurrency: 1 },
  run: { operation: "execution" },
};

describe("management Project and Run operations", () => {
  it("uses the exact Project creation schema and one existing durable creation/first-Run service", async () => {
    const app = setupManagement();
    const result = await toolValue(await app.call("create_project", creation));
    expect(result).toMatchObject({ project: { projectId: project.projectId }, run: { runId: run.runId, samplingCount: 1 } });
    expect(JSON.stringify(result)).not.toContain("ownerUserId");
    expect(app.services.projects.create).toHaveBeenCalledExactlyOnceWith({
      ...creation, name: "New project", datasets: [{ datasetId: DATASET }],
    });
    expect(app.services.admission.submit).not.toHaveBeenCalled(); // first Run belongs to projects.create
    expect(await (await app.call("create_project", { ...creation, actor: "someone-else" })).json())
      .toMatchObject({ result: { isError: true } });
    expect(app.services.projects.create).toHaveBeenCalledTimes(1);
  });

  it("passes original selector/targets/key through existing admission, and stops an explicit Project Run", async () => {
    const app = setupManagement();
    const selector = { all: true };
    const fixed = await toolValue(await app.call("preview_run", {
      projectId: project.projectId, operation: "execution", selector,
    }));
    expect(fixed).toMatchObject({ targets: preview.targets, newSamplingCount: 2 });
    expect(app.services.admission.preview).toHaveBeenCalledWith({
      projectId: project.projectId, operation: "execution", selector,
    });
    const invented = await (await app.call("submit_run", {
      projectId: project.projectId, operation: "execution", selector,
      targets: { projectSampleIds: ["different-sample"], samplingIds: [] }, idempotencyKey: "invented-key",
    })).json();
    expect(invented).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("RUN_TARGETS_STALE") }] } });
    expect(app.services.admission.submit).not.toHaveBeenCalled();
    const submitted = await toolValue(await app.call("submit_run", {
      projectId: project.projectId, operation: "execution", selector,
      targets: preview.targets, idempotencyKey: "run-key",
    }));
    expect(submitted).toEqual({ runId: "run-2", samplingCount: 1 });
    expect(app.services.admission.submit).toHaveBeenCalledExactlyOnceWith({
      projectId: project.projectId, operation: "execution", selector,
      targets: preview.targets, idempotencyKey: "run-key",
    });
    expect(await toolValue(await app.call("stop_run", { projectId: project.projectId, runId: run.runId })))
      .toEqual({ runId: run.runId, stopRequested: true });
    expect(app.services.projectRuns.stopRun).toHaveBeenCalledWith(project.projectId, run.runId);
    const missing = await (await app.call("stop_run", { projectId: "other-project", runId: run.runId })).json();
    expect(missing).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("RUN_NOT_FOUND") }] } });
  });

  it("caps MCP previews/submissions and returns only one page of Run member IDs", async () => {
    const app = setupManagement();
    const tooMany = Array.from({ length: 51 }, (_, i) => `sample-${i}`);
    app.services.admission.preview.mockResolvedValueOnce({
      ...preview, targets: { projectSampleIds: tooMany, samplingIds: [] },
    });
    const large = await (await app.call("preview_run", {
      projectId: project.projectId, operation: "execution", selector: { all: true },
    })).json();
    expect(large).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("RUN_TARGETS_TOO_LARGE") }] } });
    const hugeSubmit = await (await app.call("submit_run", {
      projectId: project.projectId, operation: "execution", selector: { all: true },
      targets: { projectSampleIds: tooMany, samplingIds: [] }, idempotencyKey: "key",
    })).json();
    expect(hugeSubmit).toMatchObject({ result: { isError: true } });
    expect(app.services.admission.submit).not.toHaveBeenCalled();
    app.services.results.getRun.mockResolvedValueOnce({ ...run, samplingIds: tooMany, sourceCommit: "private",
      targets: { projectSampleIds: tooMany, samplingIds: [] } });
    const paged = await toolValue(await app.call("get_run", { runId: run.runId, page: 2, pageSize: 20 }));
    expect(paged).toMatchObject({ counts: { samplings: 51, evaluations: 1 },
      samplings: { page: 2, pageSize: 20, total: 51, items: tooMany.slice(20, 40) } });
    expect(JSON.stringify(paged)).not.toContain("private");
    expect(app.services.results.getRun).toHaveBeenCalledWith(run.runId);
  });
});
