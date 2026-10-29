import { describe, expect, it } from "vitest";
import { detail } from "./metrics-fixture.js";
import { OWNER, project, run, setupManagement, toolValue } from "./test-fixture.js";

const args = { projectId: project.projectId, runId: run.runId, samplingId: "sampling-1" };

describe("owned, bounded case inspection", () => {
  it("shows the existing metric summary, one short Evaluator excerpt and only trajectory metadata", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(detail);
    const value = await toolValue(await app.call("inspect_case", {
      ...args, evaluationId: "evaluation-1", trajectory: "evaluator", limit: 2, beforeSeq: 5,
    }));
    expect(app.services.projectRuns.readRun).toHaveBeenCalledWith(args.projectId, args.runId);
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledWith({
      projectId: args.projectId, runIds: [args.runId], samplingId: args.samplingId,
    });
    expect(app.services.observations.evaluator).toHaveBeenCalledWith(args.projectId, "evaluation-1");
    expect(app.observation.trajectory).toHaveBeenCalledWith({ ownerUserId: OWNER, chatId: "evaluator-chat" },
      { limit: 2, beforeSeq: 5 });
    expect(value).toMatchObject({
      sampling: { evidence: { evidenceId: "sha256:proof" }, artifactCount: 1 },
      evaluation: { validation: { status: "valid" }, result: { truncated: true },
        evidenceRefs: { items: [{ ref: "/workspace/proof.txt" }, { ref: null }] } },
      trajectory: { events: [{ ingestSeq: 4, type: "tool.started", occurredAt: "2026-01-01T00:00:00Z" }] },
    });
    for (const secret of ["private Subject prompt", "private raw resource snapshot",
      "private response", "private-connection", "https://signed.test", "private-output.txt"]) {
      expect(JSON.stringify(value)).not.toContain(secret);
    }
    expect(app.observation.trajectory).toHaveBeenCalledTimes(1);
  });

  it("drops traversal-looking evidence locations while preserving owned Workspace references", async () => {
    const app = setupManagement();
    const unsafe = structuredClone(detail);
    unsafe.evaluations[0]!.output.evidenceRefs.push({ kind: "workspace", ref: "/workspace/../secret" });
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(unsafe);
    const value = await toolValue(await app.call("inspect_case", { ...args, evaluationId: "evaluation-1" }));
    expect((value.evaluation as { evidenceRefs: { items: Array<{ ref: string | null }> } }).evidenceRefs.items
      .map(({ ref }) => ref)).toEqual(["/workspace/proof.txt", null, null]);
  });

  it("rejects nonmember Sampling/Evaluation IDs before reading details or another Chat", async () => {
    const app = setupManagement();
    for (const input of [
      { ...args, samplingId: "other-sampling", trajectory: "subject" },
      { ...args, evaluationId: "other-evaluation", trajectory: "evaluator" },
      { ...args, projectId: "other-project", trajectory: "subject" },
    ]) {
      expect(await (await app.call("inspect_case", input)).json())
        .toMatchObject({ result: { isError: true } });
    }
    expect(app.services.metrics.getSamplingDetail).not.toHaveBeenCalled();
    expect(app.observation.trajectory).not.toHaveBeenCalled();
  });

  it("does not follow an observation ref for a different owner or Sampling", async () => {
    for (const mismatch of ["ownerUserId", "samplingId"] as const) {
      const app = setupManagement();
      app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
      app.services.observations.evaluator.mockResolvedValueOnce({
        role: "evaluator", projectId: args.projectId, samplingId: "sampling-1",
        evaluationId: "evaluation-1", ownerUserId: OWNER, chatId: "evaluator-chat",
        [mismatch]: "foreign",
      });
      const result = await (await app.call("inspect_case", {
        ...args, evaluationId: "evaluation-1", trajectory: "evaluator",
      })).json();
      expect(result).toMatchObject({ result: { isError: true,
        content: [{ text: expect.stringContaining("EVAL_SP_FORBIDDEN") }] } });
      expect(app.observation.trajectory).not.toHaveBeenCalled();
    }
  });

  it("does not fetch a not-started Chat or accept non-metadata or unbounded event pages", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValue(detail);
    app.services.observations.subject.mockResolvedValueOnce({
      role: "subject", projectId: args.projectId, samplingId: args.samplingId, ownerUserId: OWNER, chatId: "",
    });
    const notStarted = await toolValue(await app.call("inspect_case", { ...args, trajectory: "subject" }));
    expect(notStarted).toMatchObject({ trajectory: { state: "not-started", events: [] } });
    expect(app.observation.trajectory).not.toHaveBeenCalled();
    const invalid = await (await app.call("inspect_case", { ...args, beforeSeq: 2 })).json();
    expect(invalid).toMatchObject({ result: { isError: true } });
    expect(app.observation.trajectory).not.toHaveBeenCalled();

    app.observation.trajectory.mockResolvedValueOnce({ events: Array.from({ length: 21 }, (_, i) => ({
      ingestSeq: i, event: { type: "tool.started", occurredAt: "2026-01-01T00:00:00Z",
        payload: { input: "secret", output: "secret" } },
    })), beforeSeq: null, hasOlder: false });
    const oversized = await (await app.call("inspect_case", {
      ...args, trajectory: "subject", limit: 20,
    })).json();
    expect(oversized).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("RESPONSE_INVALID") }] } });
    expect(JSON.stringify(oversized)).not.toContain("secret");
  });
});
