import { describe, expect, it } from "vitest";
import { RuntimeRunIdentityConflictError } from "@eval-platform/eval-runtime";
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

  it("replays the persisted original Run before a changed preview, but never admits a stale new-key target", async () => {
    const app = setupManagement();
    const original = {
      projectId: project.projectId, operation: "evaluation", idempotencyKey: "original-key",
      selector: { all: true }, targets: { projectSampleIds: [], samplingIds: ["old-sampling"] },
    } as const;
    app.services.admission.preview.mockResolvedValueOnce({ ...preview, operation: "evaluation",
      targets: original.targets }).mockResolvedValue({ ...preview, operation: "evaluation",
      targets: { projectSampleIds: [], samplingIds: ["replacement-sampling"] } });
    let saved: { runId: string; samplingIds: string[] } | null = null;
    app.services.admission.submit.mockImplementation(async () => {
      saved = { runId: "original-run", samplingIds: ["old-sampling"] };
      return saved;
    });
    app.services.admission.replay.mockImplementation(async (input: unknown) => {
      const request = input as typeof original;
      if (!saved || request.idempotencyKey !== original.idempotencyKey) return null;
      if (JSON.stringify({ ...request, idempotencyKey: undefined })
        !== JSON.stringify({ ...original, idempotencyKey: undefined })) {
        throw new RuntimeRunIdentityConflictError("Different original intent");
      }
      return saved;
    });
    const first = await toolValue(await app.call("submit_run", original));
    expect(first).toEqual({ runId: "original-run", samplingCount: 1 });
    expect(await toolValue(await app.call("submit_run", original))).toEqual(first);
    expect(await toolValue(await app.call("submit_run", { ...original, replayOnly: true }))).toEqual(first);
    expect(app.services.admission.replay).toHaveBeenLastCalledWith(original); // flag was removed before Runtime
    expect(app.services.admission.preview).toHaveBeenCalledTimes(1); // current targets are different
    expect(app.services.admission.submit).toHaveBeenCalledTimes(1);

    const different = await (await app.call("submit_run", {
      ...original, targets: { projectSampleIds: [], samplingIds: ["replacement-sampling"] },
    })).json();
    expect(different).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("RUN_IDEMPOTENCY_CONFLICT") }] } });
    expect(app.services.admission.preview).toHaveBeenCalledTimes(1);
    const differentReplayOnly = await (await app.call("submit_run", {
      ...original, selector: { samplingIds: ["old-sampling"] }, replayOnly: true,
    })).json();
    expect(differentReplayOnly).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("RUN_IDEMPOTENCY_CONFLICT") }] } });
    expect(app.services.admission.preview).toHaveBeenCalledTimes(1);
    expect(app.services.admission.submit).toHaveBeenCalledTimes(1);

    const stale = await (await app.call("submit_run", { ...original, idempotencyKey: "genuinely-new" })).json();
    expect(stale).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("RUN_TARGETS_STALE") }] } });
    expect(app.services.admission.submit).toHaveBeenCalledTimes(1);
    expect(app.services.admission.replay).toHaveBeenCalledWith(original);
  });

  it("replayOnly recovers an existing Run after its explicit Sampling disappears without a current preview", async () => {
    const app = setupManagement();
    const request = {
      projectId: project.projectId, operation: "execution", selector: { samplingIds: ["replaced"] },
      targets: { projectSampleIds: [], samplingIds: ["replaced"] }, idempotencyKey: "original-key",
    } as const;
    app.services.admission.replay.mockResolvedValueOnce({ runId: "original-run", samplingIds: ["new-sampling"] });
    app.services.admission.preview.mockRejectedValueOnce(new Error("Original Sampling was replaced"));
    expect(await toolValue(await app.call("submit_run", { ...request, replayOnly: true })))
      .toEqual({ runId: "original-run", samplingCount: 1 });
    expect(app.services.admission.replay).toHaveBeenCalledExactlyOnceWith(request);
    expect(app.services.admission.preview).not.toHaveBeenCalled();
    expect(app.services.admission.submit).not.toHaveBeenCalled();
  });

  it("replayOnly miss never starts a Run even if today's changed plan has the same targets; fresh approval uses live preview", async () => {
    const app = setupManagement();
    const request = {
      projectId: project.projectId, operation: "execution", selector: { all: true },
      targets: preview.targets, idempotencyKey: "old-private-approval",
    } as const;
    // Only the plan/Agent/Data changed; a targets-only preview would misleadingly match.
    app.services.admission.preview.mockResolvedValue({ ...preview, executionPlanDigest: "different-plan" });
    const missed = await (await app.call("submit_run", { ...request, replayOnly: true })).json();
    expect(missed).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("RUN_NOT_FOUND") }] } });
    expect(app.services.admission.replay).toHaveBeenCalledExactlyOnceWith(request);
    expect(app.services.admission.preview).not.toHaveBeenCalled();
    expect(app.services.admission.submit).not.toHaveBeenCalled();

    const fresh = { ...request, idempotencyKey: "freshly-approved-key" };
    expect(await toolValue(await app.call("submit_run", fresh))).toEqual({ runId: "run-2", samplingCount: 1 });
    expect(app.services.admission.preview).toHaveBeenCalledExactlyOnceWith({
      projectId: fresh.projectId, operation: fresh.operation, selector: fresh.selector,
    });
    expect(app.services.admission.submit).toHaveBeenCalledExactlyOnceWith(fresh);

    const invalid = await (await app.call("submit_run", { ...fresh, replayOnly: false })).json();
    expect(invalid).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("REQUEST_INVALID_INPUT") }] } });
    expect(app.services.admission.submit).toHaveBeenCalledTimes(1);
  });

  it("recovers a Run committed between the stored-key lookup and a now-failing preview", async () => {
    const app = setupManagement();
    const request = { projectId: project.projectId, operation: "execution", selector: { samplingIds: ["replaced"] },
      targets: { projectSampleIds: [], samplingIds: ["replaced"] }, idempotencyKey: "racing-key" } as const;
    app.services.admission.replay.mockResolvedValueOnce(null).mockResolvedValueOnce({
      runId: "committed-run", samplingIds: ["new-sampling"],
    });
    app.services.admission.preview.mockRejectedValueOnce(new Error("Sampling was replaced"));
    expect(await toolValue(await app.call("submit_run", request))).toEqual({
      runId: "committed-run", samplingCount: 1,
    });
    expect(app.services.admission.replay).toHaveBeenCalledTimes(2);
    expect(app.services.admission.submit).not.toHaveBeenCalled();
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
