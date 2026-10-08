import type { EvaluationRecord } from "@eval-platform/eval-contracts";
import type { EvaluationMetrics } from "./model.js";

export type { EvaluationMetrics } from "./model.js";

export function readEvaluationMetrics(record: EvaluationRecord): EvaluationMetrics {
  const score = record.output?.score;
  const scoreStatus = score === undefined ? "unavailable" : Number.isFinite(score) ? "available" : "invalid";
  return structuredClone({
    evaluationId: record.evaluationId,
    samplingId: record.samplingId,
    evaluator: record.evaluator,
    stage: record.status,
    outputStatus: record.output?.status ?? null,
    score: { status: scoreStatus, value: scoreStatus === "available" ? score! : null },
    reason: record.output?.reason ?? null,
    outputError: record.output?.error ?? null,
    artifacts: record.output?.artifacts ?? [],
    trajectory: record.output?.trajectory ?? null,
    evidenceRefs: record.output?.evidenceRefs ?? [],
  });
}
