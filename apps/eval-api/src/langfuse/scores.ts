import type { EvaluationScore } from "@eval-platform/eval-runtime";
import type { Fetch } from "../sp/http.js";

export interface LangfuseConfig {
  readonly baseUrl: string;
  readonly publicKey: string;
  readonly secretKey: string;
  /** Must match the environment Eval SP reports its traces under, or the score is filtered out of their view. */
  readonly environment?: string;
}

export const JUDGE_SCORE_NAME = "judge-score";
const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;

/** The score's own ID, so a retried or repeated sync overwrites the same Langfuse score. */
export function langfuseScoreId(evaluationId: string): string {
  return `eval-score:${evaluationId}`;
}

/** Publish an Evaluation score on the Subject's Langfuse session (SP reports each Chat as one session). */
export function createLangfuseScorePublisher(input: {
  readonly config: LangfuseConfig;
  readonly fetch?: Fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): (score: EvaluationScore) => Promise<void> {
  const { config } = input;
  const fetchScore = input.fetch ?? globalThis.fetch;
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const url = new URL("/api/public/scores", config.baseUrl).href;
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
  return async (score) => {
    const body = JSON.stringify({
      id: langfuseScoreId(score.evaluationId),
      sessionId: score.subjectChatId,
      name: JUDGE_SCORE_NAME,
      value: score.score,
      dataType: "NUMERIC",
      ...(score.reason === undefined ? {} : { comment: score.reason }),
      ...(config.environment === undefined ? {} : { environment: config.environment }),
      metadata: {
        projectId: score.projectId,
        sampleId: score.sampleId,
        samplingId: score.samplingId,
        evaluationId: score.evaluationId,
        evaluatorChatId: score.evaluatorChatId,
      },
    });
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(500 * 2 ** (attempt - 2));
      let response: Response;
      try {
        response = await fetchScore(url, {
          method: "POST",
          headers: { Authorization: authorization, "Content-Type": "application/json" },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        lastError = new Error(`Langfuse score request failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (response.ok) return;
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      lastError = new Error(`Langfuse rejected the score with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      if (response.status !== 429 && response.status < 500) break;
    }
    throw lastError!;
  };
}
