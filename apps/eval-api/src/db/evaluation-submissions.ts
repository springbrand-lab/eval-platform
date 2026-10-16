import type { EvaluationOutputSchema, EvaluationStructuredOutput, SamplingStatus } from "@eval-platform/eval-contracts";
import { EVALUATION_SUBMISSION_PATH, sha256Hex } from "@eval-platform/eval-contracts";
import { eq } from "drizzle-orm";
import type { EvalDb } from "./client.js";
import { readEvaluationOutputSchema } from "./project-plans.js";
import { evaluationFromRow } from "./run-records.js";
import { evaluationSubmissions, evaluations, samplings } from "./schema.js";

export interface EvaluationSubmissionTarget {
  readonly ownerUserId: string;
  readonly status: SamplingStatus;
  /** The Project's locked output Schema; null when the Project has none. */
  readonly schema: EvaluationOutputSchema | null;
}

export type EvaluationSubmissionStore = ReturnType<typeof createPostgresEvaluationSubmissions>;

/** Results handed over through the submission tool; see docs/eval-evaluation-result-submission.md. */
export function createPostgresEvaluationSubmissions(db: EvalDb) {
  return {
    async read(evaluationId: string): Promise<EvaluationStructuredOutput | undefined> {
      const [row] = await db.select().from(evaluationSubmissions).where(eq(evaluationSubmissions.evaluationId, evaluationId));
      return row ? { path: EVALUATION_SUBMISSION_PATH, content: row.content, contentHash: row.contentHash } : undefined;
    },
    async target(evaluationId: string): Promise<EvaluationSubmissionTarget | null> {
      const [row] = await db.select({ evaluation: evaluations, projectId: samplings.projectId }).from(evaluations)
        .innerJoin(samplings, eq(samplings.samplingId, evaluations.samplingId))
        .where(eq(evaluations.evaluationId, evaluationId));
      if (!row) return null;
      const evaluation = evaluationFromRow(row.evaluation);
      return {
        ownerUserId: row.evaluation.ownerUserId,
        status: evaluation.status.status,
        schema: await readEvaluationOutputSchema(db, row.projectId, row.evaluation.ownerUserId),
      };
    },
    /** The latest valid submission wins; validation happens before this call. */
    async save(input: { readonly evaluationId: string; readonly ownerUserId: string; readonly content: string; readonly submittedAt: Date }): Promise<void> {
      const values = {
        ownerUserId: input.ownerUserId,
        content: input.content,
        contentHash: `sha256:${await sha256Hex(input.content)}`,
        submittedAt: input.submittedAt,
      };
      await db.insert(evaluationSubmissions).values({ evaluationId: input.evaluationId, ...values })
        .onConflictDoUpdate({ target: evaluationSubmissions.evaluationId, set: values });
    },
  };
}
