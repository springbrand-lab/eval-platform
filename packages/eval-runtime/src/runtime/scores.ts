import type { EvaluationAgentOutput, EvaluationOutputSchema, ScoreSyncState } from "@eval-platform/eval-contracts";
import type { RuntimeStore } from "./store.js";

/** One scored Evaluation, addressed to the Subject's SP Chat (the Langfuse session of its traces). */
export interface EvaluationScore {
  readonly evaluationId: string;
  readonly samplingId: string;
  readonly projectId: string;
  readonly sampleId: string;
  readonly subjectChatId: string;
  readonly evaluatorChatId: string;
  readonly score: number;
  readonly reason?: string;
}

export interface EvaluationScorePort {
  /** Problems found checking a result against the Project's output schema; empty when it conforms. */
  validate(schema: EvaluationOutputSchema, result: NonNullable<EvaluationAgentOutput["result"]>): readonly string[];
  /** Deliver one score; repeating it for the same Evaluation must overwrite, not duplicate. */
  publish?(score: EvaluationScore): Promise<void>;
}

/** Read the score from a succeeded Evaluator output, or say why it has none. */
export function readEvaluationScore(
  output: EvaluationAgentOutput,
  schema: EvaluationOutputSchema,
  port: EvaluationScorePort | undefined,
): { readonly score: number; readonly reason?: string } | { readonly problem: string } {
  const result = output.result;
  if (result === undefined) return { problem: "Evaluator output has no result" };
  const problems = port?.validate(schema, result) ?? [];
  if (problems.length > 0) {
    return { problem: `Evaluator result does not follow the output schema: ${problems.join("; ")}` };
  }
  const { score, reason } = result;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return { problem: "Evaluator result has no numeric score" };
  }
  if (reason !== undefined && typeof reason !== "string") {
    return { problem: "Evaluator result reason must be a string" };
  }
  return reason === undefined ? { score } : { score, reason };
}

/** Publish one score and describe the outcome; a failure never fails the Evaluation itself. */
export async function publishEvaluationScore(
  publish: NonNullable<EvaluationScorePort["publish"]>,
  score: EvaluationScore,
  now: () => string,
): Promise<ScoreSyncState> {
  try {
    await publish(score);
    return { status: "synced", at: now() };
  } catch (error) {
    return { status: "failed", at: now(), lastError: error instanceof Error ? error.message : String(error) };
  }
}

export interface ScoreSyncSummary {
  readonly synced: number;
  readonly failed: number;
  /** Not scored, or already synced. */
  readonly skipped: number;
}

/** Deliver every scored, not yet synced Evaluation of one Run again; it stops on a record changed meanwhile. */
export async function syncRunScores(input: {
  readonly store: Pick<RuntimeStore, "getRun" | "getEvaluations" | "getSamplings" | "updateEvaluation">;
  readonly runId: string;
  readonly publish: NonNullable<EvaluationScorePort["publish"]>;
  readonly now: () => string;
}): Promise<ScoreSyncSummary | null> {
  const run = await input.store.getRun(input.runId);
  if (!run) return null;
  const evaluations = (await input.store.getEvaluations(run.evaluationIds)).flatMap((record) => record ? [record] : []);
  const samplings = new Map((await input.store.getSamplings(evaluations.map(({ samplingId }) => samplingId)))
    .flatMap((sampling) => sampling ? [[sampling.samplingId, sampling] as const] : []));
  let synced = 0;
  let failed = 0;
  for (const evaluation of evaluations) {
    const sampling = samplings.get(evaluation.samplingId);
    const score = evaluation.output?.score;
    if (evaluation.status.status !== "succeeded" || score === undefined || evaluation.scoreSync?.status === "synced"
      || !sampling?.subjectChatId || !evaluation.chatId) continue;
    const reason = evaluation.output?.reason;
    const scoreSync = await publishEvaluationScore(input.publish, {
      evaluationId: evaluation.evaluationId,
      samplingId: sampling.samplingId,
      projectId: sampling.projectId,
      sampleId: sampling.sampleId,
      subjectChatId: sampling.subjectChatId,
      evaluatorChatId: evaluation.chatId,
      score,
      ...(reason === undefined ? {} : { reason }),
    }, input.now);
    await input.store.updateEvaluation({ ...evaluation, scoreSync }, evaluation);
    if (scoreSync.status === "synced") synced += 1;
    else failed += 1;
  }
  return { synced, failed, skipped: evaluations.length - synced - failed };
}
