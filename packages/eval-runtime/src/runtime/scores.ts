import type { EvaluationRecord, EvaluationOutputSchema, ScoreSyncState } from "@eval-platform/eval-contracts";
import type { RuntimeStore } from "./store.js";

/** One scored Evaluation, addressed to the Subject's SP Chat (the Langfuse session of its traces). */
export interface EvaluationScore {
  readonly evaluationId: string;
  readonly samplingId: string;
  readonly projectId: string;
  readonly projectSampleId: string;
  readonly subjectChatId: string;
  readonly evaluatorChatId: string;
  readonly score: number;
  readonly reason?: string;
}

export interface EvaluationScorePort {
  /** Metrics owns parsing and Schema validation; no score is a valid outcome. Never mutates the raw record. */
  read(schema: EvaluationOutputSchema, record: EvaluationRecord): Pick<EvaluationScore, "score" | "reason"> | undefined;
  /** Deliver one score; repeating it for the same Evaluation must overwrite, not duplicate. */
  publish?(score: EvaluationScore): Promise<void>;
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
  readonly read: EvaluationScorePort["read"];
  readonly schema: EvaluationOutputSchema;
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
    if (evaluation.status.status !== "succeeded" || evaluation.scoreSync?.status === "synced"
      || !sampling?.subjectChatId || !evaluation.chatId) continue;
    const scored = input.read(input.schema, evaluation);
    if (!scored) continue;
    const scoreSync = await publishEvaluationScore(input.publish, {
      evaluationId: evaluation.evaluationId,
      samplingId: sampling.samplingId,
      projectId: sampling.projectId,
      projectSampleId: sampling.projectSampleId,
      subjectChatId: sampling.subjectChatId,
      evaluatorChatId: evaluation.chatId,
      ...scored,
    }, input.now);
    await input.store.updateEvaluation({ ...evaluation, scoreSync }, evaluation);
    if (scoreSync.status === "synced") synced += 1;
    else failed += 1;
  }
  return { synced, failed, skipped: evaluations.length - synced - failed };
}
