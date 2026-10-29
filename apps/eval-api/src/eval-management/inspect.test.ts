import { MetricsEntityNotFoundError } from "@eval-platform/eval-metrics";
import { RuntimeEntityNotFoundError } from "@eval-platform/eval-runtime";
import { describe, expect, it } from "vitest";
import { detail } from "./metrics-fixture.js";
import { MANAGEMENT_TOKEN, OWNER, project, run, setupManagement, toolValue } from "./test-fixture.js";

const args = { projectId: project.projectId, runId: run.runId, samplingId: "sampling-1" };

describe("bounded owned case inspection (trajectory files use a separate authenticated GET)", () => {
  it("keeps exact-Run membership and selected Evaluator Metrics/evidence bounded", async () => {
    const app = setupManagement();
    const unsafe = structuredClone(detail);
    unsafe.evaluations[0]!.output.evidenceRefs.push({ kind: "workspace", ref: "/workspace/../secret" });
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(unsafe);
    const value = await toolValue(await app.call("inspect_case", { ...args, evaluationId: "evaluation-1" }));
    expect(app.services.projectRuns.readRun).toHaveBeenCalledWith(args.projectId, args.runId);
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledWith({
      projectId: args.projectId, runIds: [args.runId], samplingId: args.samplingId,
    });
    expect(value).toMatchObject({
      runScope: "exact_run", runId: run.runId,
      summary: { executionAgent: { toolSuccessRate: { value: 0.5 } } },
      subject: { toolSuccessRate: { value: 0.5, coverage: "complete" } },
      evaluation: { result: { truncated: true }, evaluator: { toolSuccessRate: { value: null, coverage: "unavailable" } } },
    });
    expect((value.evaluation as { evidenceRefs: { items: Array<{ ref: string | null }> } }).evidenceRefs.items
      .map(({ ref }) => ref)).toEqual(["/workspace/proof.txt", null, null]);
    expect(value).not.toHaveProperty("trajectory.recordJson");
    expect(app.services.observations.subject).not.toHaveBeenCalled();
    expect(app.services.observations.evaluator).not.toHaveBeenCalled();
    expect(app.observation.trajectory).not.toHaveBeenCalled();
    for (const secret of [MANAGEMENT_TOKEN, "fixed-session", "private Subject prompt", "private raw resource snapshot",
      "private-connection", "https://signed.test", "private-output.txt"]) {
      expect(JSON.stringify(value)).not.toContain(secret);
    }
  });

  it("follows current Sampling/Evaluation without inventing Run membership or reading SP", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(detail);
    const value = await toolValue(await app.call("inspect_case", {
      projectId: args.projectId, samplingId: args.samplingId, evaluationId: "evaluation-1",
    }));
    expect(app.services.projectRuns.readRun).not.toHaveBeenCalled();
    expect(app.services.metrics.getSamplingDetail).toHaveBeenCalledExactlyOnceWith({
      projectId: args.projectId, samplingId: args.samplingId,
    });
    expect(value).toMatchObject({ runScope: "project_current", samplingId: args.samplingId,
      evaluations: { total: 1 }, evaluation: { evaluationId: "evaluation-1" } });
    expect(value).not.toHaveProperty("runId");
    expect(app.observation.trajectory).not.toHaveBeenCalled();
  });

  it("rejects old 4-KiB/continuation arguments, with no second byte path", async () => {
    const app = setupManagement();
    for (const field of [
      { trajectory: "subject" }, { afterSeq: 0 }, { throughSeq: 1 }, { ingestSeq: 1 }, { offset: 0 },
      { limit: 1 },
    ]) {
      const result = await (await app.call("inspect_case", { ...args, ...field })).json();
      expect(result).toMatchObject({ result: { isError: true,
        content: [{ text: expect.stringContaining("REQUEST_INVALID_INPUT") }] } });
    }
    expect(app.services.metrics.getSamplingDetail).not.toHaveBeenCalled();
    expect(app.observation.trajectory).not.toHaveBeenCalled();
  });

  it("rejects nonmember exact-Run identities before current Metrics or observing a Chat", async () => {
    const app = setupManagement();
    for (const input of [
      { ...args, samplingId: "other-sampling" },
      { ...args, evaluationId: "other-evaluation" },
      { ...args, projectId: "other-project" },
    ]) {
      expect(await (await app.call("inspect_case", input)).json())
        .toMatchObject({ result: { isError: true } });
    }
    expect(app.services.metrics.getSamplingDetail).not.toHaveBeenCalled();
    expect(app.observation.trajectory).not.toHaveBeenCalled();
  });

  it("rejects deleted/replaced/foreign current facts and a mismatched Evaluator association", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockRejectedValueOnce(
      new MetricsEntityNotFoundError("sampling", args.samplingId));
    expect(await (await app.call("inspect_case", args)).json()).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("SAMPLING_NOT_FOUND") }] } });
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce({
      ...detail, project: { ...detail.project, ownerUserId: "foreign" },
    });
    expect(await (await app.call("inspect_case", args)).json()).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("EVAL_SP_FORBIDDEN") }] } });
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce({
      ...detail, evaluations: [{ ...detail.evaluations[0]!,
        record: { ...detail.evaluations[0]!.record, samplingId: "other-sampling" } }],
    });
    expect(await (await app.call("inspect_case", { ...args, evaluationId: "evaluation-1" })).json())
      .toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("EVALUATION_NOT_FOUND") }] } });
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce(detail);
    app.services.projectRuns.readRun.mockRejectedValueOnce(new RuntimeEntityNotFoundError("run", args.runId));
    expect(await (await app.call("inspect_case", args)).json()).toMatchObject({ result: { isError: true } });
    expect(app.observation.trajectory).not.toHaveBeenCalled();
  });

  it("retains Subject Chat identity in the owned current Metrics even without an observation read", async () => {
    const app = setupManagement();
    app.services.metrics.getSamplingDetail.mockResolvedValueOnce({
      ...detail, subject: { ...detail.subject, chatId: "foreign-chat",
        agentConfigRef: { ownerUserId: OWNER, userAgentId: "subject-agent" } },
    });
    expect(await (await app.call("inspect_case", args)).json()).toMatchObject({ result: { isError: true,
      content: [{ text: expect.stringContaining("EVAL_SP_FORBIDDEN") }] } });
  });
});
