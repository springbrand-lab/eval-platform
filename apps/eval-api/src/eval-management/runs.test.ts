import { describe, expect, it } from "vitest";
import { RuntimeAdmissionConflictError, RuntimeRunIdentityConflictError } from "@eval-platform/eval-runtime";
import { ProjectIdempotencyConflictError } from "../db/errors.js";
import { AGENT, DATASET, preview, project, run, setupManagement, toolValue } from "./test-fixture.js";

const creation = {
  idempotencyKey: "project-key", name: " New project ", datasets: [{ datasetId: DATASET.toUpperCase() }],
  samplingCount: 2, execution: { userAgentId: AGENT, framework: "sp", executionConcurrency: 1 },
  run: { operation: "execution" },
  expectedSnapshots: { datasets: [{ datasetId: DATASET, digest: "a".repeat(64) }], executionAgent: "b".repeat(64) },
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

  it("passes the preview's plan digest and fixed facts once to Runtime, and stops an explicit Project Run", async () => {
    const app = setupManagement();
    const selector = { all: true };
    const fixed = await toolValue(await app.call("preview_run", {
      projectId: project.projectId, operation: "execution", selector,
    }));
    expect(fixed).toMatchObject({ targets: preview.targets, newSamplingCount: 2 });
    expect(app.services.admission.preview).toHaveBeenCalledWith({
      projectId: project.projectId, operation: "execution", selector,
    });
    const command = {
      projectId: project.projectId, operation: "execution", selector,
      targets: preview.targets, idempotencyKey: "run-key",
      expectedPlanDigests: { execution: preview.executionPlanDigest },
    };
    const submitted = await toolValue(await app.call("submit_run", command));
    expect(submitted).toEqual({ runId: "run-2", samplingCount: 1 });
    expect(app.services.admission.submit).toHaveBeenCalledExactlyOnceWith(command);
    expect(app.services.admission.preview).toHaveBeenCalledOnce(); // only explicit preview_run
    expect(app.services.admission.replay).not.toHaveBeenCalled();
    expect(await toolValue(await app.call("stop_run", { projectId: project.projectId, runId: run.runId })))
      .toEqual({ runId: run.runId, stopRequested: true });
    expect(app.services.projectRuns.stopRun).toHaveBeenCalledWith(project.projectId, run.runId);
    const missing = await (await app.call("stop_run", { projectId: "other-project", runId: run.runId })).json();
    expect(missing).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("RUN_NOT_FOUND") }] } });
  });

  it("delegates a D1-approved same-target D2 rejection to Runtime without re-previewing or re-replaying", async () => {
    const app = setupManagement();
    const original = {
      projectId: project.projectId, operation: "evaluation", idempotencyKey: "approved-d1",
      selector: { all: true }, targets: { projectSampleIds: [], samplingIds: ["same-target"] },
      expectedPlanDigests: { execution: preview.executionPlanDigest, evaluation: "c".repeat(64) },
    };
    // Only the evaluation plan changed; the fixed targets still match.
    app.services.admission.submit.mockRejectedValueOnce(
      new RuntimeAdmissionConflictError("plan-changed", "Expected D1, current D2"),
    );
    const stale = await (await app.call("submit_run", original)).json();
    expect(stale).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("PROJECT_PLAN_CHANGED") }] } });
    expect(app.services.admission.submit).toHaveBeenCalledExactlyOnceWith(original);
    expect(app.services.admission.preview).not.toHaveBeenCalled();
    expect(app.services.admission.replay).not.toHaveBeenCalled();
    const current = { ...original, idempotencyKey: "new-approved-key",
      expectedPlanDigests: { ...original.expectedPlanDigests, evaluation: "d".repeat(64) } };
    expect(await toolValue(await app.call("submit_run", current))).toEqual({ runId: "run-2", samplingCount: 1 });
    expect(app.services.admission.submit).toHaveBeenCalledTimes(2);
  });

  it("reconciles an already-stored Run after its Sampling was replaced, allowing only read-only legacy digests", async () => {
    const app = setupManagement();
    const original = {
      projectId: project.projectId, operation: "execution", idempotencyKey: "original-key",
      selector: { samplingIds: ["replaced"] }, targets: { projectSampleIds: [], samplingIds: ["replaced"] },
      expectedPlanDigests: { execution: preview.executionPlanDigest },
    };
    app.services.admission.replay.mockImplementation(async (input: unknown) => {
      const request = input as typeof original;
      if (request.projectId !== original.projectId || request.idempotencyKey !== original.idempotencyKey) return null;
      if (JSON.stringify(request.selector) !== JSON.stringify(original.selector)
        || JSON.stringify(request.targets) !== JSON.stringify(original.targets)
        || request.expectedPlanDigests && request.expectedPlanDigests.execution !== original.expectedPlanDigests.execution) {
        throw new RuntimeRunIdentityConflictError("Original Run identity differs");
      }
      return { runId: "original-run", samplingIds: [] }; // replaced membership is no longer retained
    });
    app.services.admission.preview.mockRejectedValue(new Error("Today the old Sampling is gone"));
    expect(await toolValue(await app.call("reconcile_operation", { kind: "run", request: original })))
      .toEqual({ projectId: project.projectId, runId: "original-run", samplingCount: 0 });
    const { expectedPlanDigests: _digest, ...legacy } = original;
    expect(await toolValue(await app.call("reconcile_operation", { kind: "run", request: legacy })))
      .toMatchObject({ runId: "original-run" });
    for (const request of [
      { ...original, idempotencyKey: "missing-run" },
      { ...original, projectId: "other-project" },
    ]) {
      const result = await (await app.call("reconcile_operation", { kind: "run", request })).json();
      expect(result).toMatchObject({ result: { isError: true,
        content: [{ text: expect.stringContaining("RUN_NOT_FOUND") }] } });
    }
    expect((await (await app.call("reconcile_operation", { kind: "run", request: {
      ...original, expectedPlanDigests: { execution: "f".repeat(64) },
    } })).json())).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("RUN_IDEMPOTENCY_CONFLICT") }] } });
    expect((await (await app.call("reconcile_operation", { kind: "run", request: {
      ...original, selector: { all: true },
    } })).json())).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("RUN_IDEMPOTENCY_CONFLICT") }] } });
    expect(app.services.admission.preview).not.toHaveBeenCalled();
    expect(app.services.admission.submit).not.toHaveBeenCalled();
    expect(app.services.projects.create).not.toHaveBeenCalled();
  });

  it("reconciles only a previously persisted exact Project body and first Run; a partial creation stays unknown", async () => {
    const app = setupManagement();
    const normalized = { ...creation, name: "New project", datasets: [{ datasetId: DATASET }] };
    app.services.projects.reconcile.mockImplementation(async (input: unknown) => {
      const body = input as typeof normalized;
      if (body.idempotencyKey === "missing-project") return null;
      if (body.name !== normalized.name || body.datasets[0]?.datasetId !== DATASET) {
        throw new ProjectIdempotencyConflictError();
      }
      return { project, run: body.idempotencyKey === "unfinished-project" ? null
        : { runId: run.runId, samplingIds: run.samplingIds } };
    });
    expect(await toolValue(await app.call("reconcile_operation", { kind: "project", request: creation })))
      .toEqual({ projectId: project.projectId, runId: run.runId, samplingCount: 1 });
    for (const [idempotencyKey, code] of [
      ["missing-project", "PROJECT_NOT_FOUND"], ["unfinished-project", "OPERATION_OUTCOME_UNKNOWN"],
    ]) {
      const result = await (await app.call("reconcile_operation", {
        kind: "project", request: { ...creation, idempotencyKey },
      })).json();
      expect(result).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining(code!) }] } });
    }
    const changed = await (await app.call("reconcile_operation", {
      kind: "project", request: { ...creation, name: "Wrong approved name" },
    })).json();
    expect(changed).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("PROJECT_IDEMPOTENCY_CONFLICT") }] } });
    expect(app.services.projects.create).not.toHaveBeenCalled();
    expect(app.services.admission.preview).not.toHaveBeenCalled();
    expect(app.services.admission.submit).not.toHaveBeenCalled();
  });

  it("rejects omitted submit digests and the removed replayOnly flag without any admission", async () => {
    const app = setupManagement();
    const request = {
      projectId: project.projectId, operation: "execution", selector: { all: true },
      targets: preview.targets, idempotencyKey: "run-key", expectedPlanDigests: { execution: preview.executionPlanDigest },
    };
    const { expectedPlanDigests: _digest, ...missing } = request;
    for (const invalid of [missing, { ...request, replayOnly: true }, { ...request, replayOnly: false }]) {
      expect((await (await app.call("submit_run", invalid)).json()))
        .toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("REQUEST_INVALID_INPUT") }] } });
    }
    expect(app.services.admission.submit).not.toHaveBeenCalled();
    expect(app.services.admission.replay).not.toHaveBeenCalled();
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
