import { describe, expect, it, vi } from "vitest";
import { createLangfuseScorePublisher } from "./scores.js";

const config = { baseUrl: "https://langfuse.test", publicKey: "pk", secretKey: "sk", environment: "dev" };
const score = {
  evaluationId: "evaluation-1",
  samplingId: "sampling-1",
  projectId: "project-1",
  sampleId: "sample-1",
  subjectChatId: "11111111-1111-4111-8111-111111111111",
  evaluatorChatId: "22222222-2222-4222-8222-222222222222",
  score: 8,
  reason: "Complete page",
};
const sleep = async () => undefined;

describe("Langfuse score publisher", () => {
  it("posts one idempotent session score for the Subject Chat", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    await createLangfuseScorePublisher({ config, fetch, sleep })(score);

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://langfuse.test/api/public/scores");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Basic ${Buffer.from("pk:sk").toString("base64")}`);
    expect(JSON.parse(String(init.body))).toEqual({
      id: "eval-score:evaluation-1",
      sessionId: score.subjectChatId,
      name: "judge-score",
      value: 8,
      dataType: "NUMERIC",
      comment: "Complete page",
      environment: "dev",
      metadata: {
        projectId: "project-1",
        sampleId: "sample-1",
        samplingId: "sampling-1",
        evaluationId: "evaluation-1",
        evaluatorChatId: score.evaluatorChatId,
      },
    });
  });

  it("retries throttling and server errors, then succeeds", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await createLangfuseScorePublisher({ config, fetch, sleep })(score);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry a rejected score and reports Langfuse's reason", async () => {
    const fetch = vi.fn(async () => new Response("invalid sessionId", { status: 400 }));
    await expect(createLangfuseScorePublisher({ config, fetch, sleep })(score))
      .rejects.toThrow("Langfuse rejected the score with HTTP 400: invalid sessionId");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after three failed attempts", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 503 }));
    await expect(createLangfuseScorePublisher({ config, fetch, sleep })(score)).rejects.toThrow("HTTP 503");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
