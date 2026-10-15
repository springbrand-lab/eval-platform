import { describe, expect, it, vi } from "vitest";
import { publishEvaluationScore, readEvaluationScore, syncRunScores } from "./scores.js";

const output = (result?: unknown, content = JSON.stringify(result)) => ({
  status: "succeeded" as const,
  artifacts: [],
  trajectory: { trajectoryId: "chat-2", source: "evaluator" as const, path: "/api/chats/chat-2/trajectory" },
  ...(result === undefined ? {} : { structuredOutput: { path: "/evaluations/e/result.json", content } }),
});
const schema = { type: "object" };
const accept = { validate: () => [] };

describe("Evaluator score", () => {
  it("reads score and reason from a conforming result", () => {
    expect(readEvaluationScore(output({ score: 8, reason: "ok", extra: [1] }), schema, accept))
      .toEqual({ score: 8, reason: "ok" });
    expect(readEvaluationScore(output({ score: 0 }), schema, undefined)).toEqual({ score: 0 });
  });

  it.each([
    [undefined, "has no result file"],
    [[1], "must contain a JSON object"],
    [{ reason: "missing" }, "no numeric score"],
    [{ score: "8" }, "no numeric score"],
    [{ score: 8, reason: 1 }, "reason must be a string"],
  ])("explains why %j has no score", (result, problem) => {
    expect(readEvaluationScore(output(result), schema, accept)).toEqual({ problem: expect.stringContaining(problem) });
  });

  it("rejects a result file that is not strict JSON", () => {
    expect(readEvaluationScore(output({}, '{"score":1,"score":2}'), schema, accept))
      .toEqual({ problem: expect.stringContaining("not valid JSON") });
  });

  it("reports schema problems before reading the score", () => {
    expect(readEvaluationScore(output({ score: 8 }), schema, { validate: () => ["/score too high", "/reason required"] }))
      .toEqual({ problem: "Evaluator result does not follow the output schema: /score too high; /reason required" });
  });

  it("describes a delivered and an undelivered score", async () => {
    const score = {
      evaluationId: "e", samplingId: "s", projectId: "p", projectSampleId: "x", subjectChatId: "c1", evaluatorChatId: "c2", score: 1,
    };
    await expect(publishEvaluationScore(async () => undefined, score, () => "t")).resolves.toEqual({ status: "synced", at: "t" });
    await expect(publishEvaluationScore(async () => { throw new Error("down"); }, score, () => "t"))
      .resolves.toEqual({ status: "failed", at: "t", lastError: "down" });
  });
});

describe("Run score re-sync", () => {
  const scored = (evaluationId: string, scoreSync?: { status: "synced" | "failed"; at: string }) => ({
    evaluationId,
    samplingId: `sampling-${evaluationId}`,
    evaluator: { ownerUserId: "owner", userAgentId: "judge" },
    chatId: `judge-${evaluationId}`,
    status: { status: "succeeded" as const },
    attempts: [],
    output: { ...output({ score: 7 }), score: 7, reason: "fine" },
    ...(scoreSync === undefined ? {} : { scoreSync }),
  });
  const failedEvaluation = { ...scored("e3"), status: { status: "failed" as const } };
  const records = [scored("e1", { status: "failed", at: "t0" }), scored("e2", { status: "synced", at: "t0" }), failedEvaluation];

  it("publishes only scored Evaluations that are not synced yet and records the outcome", async () => {
    const updateEvaluation = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);
    const summary = await syncRunScores({
      store: {
        getRun: async () => ({ evaluationIds: ["e1", "e2", "e3"] }) as never,
        getEvaluations: async () => records,
        getSamplings: async (ids) => ids.map((samplingId) => ({
          samplingId, projectId: "p", projectSampleId: "x", subjectChatId: `subject-${samplingId}`,
        }) as never),
        updateEvaluation,
      },
      runId: "run-1",
      publish,
      now: () => "t1",
    });

    expect(summary).toEqual({ synced: 1, failed: 0, skipped: 2 });
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      evaluationId: "e1", subjectChatId: "subject-sampling-e1", evaluatorChatId: "judge-e1", score: 7, reason: "fine",
    }));
    expect(updateEvaluation).toHaveBeenCalledExactlyOnceWith(
      { ...records[0], scoreSync: { status: "synced", at: "t1" } }, records[0]);
  });

  it("returns null for an unknown Run", async () => {
    await expect(syncRunScores({
      store: { getRun: async () => null } as never, runId: "missing", publish: async () => undefined, now: () => "t",
    })).resolves.toBeNull();
  });
});
