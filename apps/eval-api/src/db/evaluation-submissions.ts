import type { EvaluationAgentOutput, EvaluationOutputSchema, EvaluationStructuredOutput, SamplingStatus } from "@eval-platform/eval-contracts";
import { canonicalJsonBytes, equalJson, EVALUATION_SUBMISSION_PATH, isStageRecoveryPending, sha256Hex, startResourceWait } from "@eval-platform/eval-contracts";
import { evaluationAgentEnded, stageOwesResources } from "@eval-platform/eval-runtime";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { RunQueue } from "../run-worker-queue.js";
import type { EvalDb } from "./client.js";
import { readEvaluationOutputSchema } from "./project-plans.js";
import { evaluationSubmissions, evaluations, projects, runEvaluations, runs, samplings } from "./schema.js";

export interface EvaluationSubmissionTarget {
  readonly ownerUserId: string;
  readonly status: SamplingStatus;
  readonly schema: EvaluationOutputSchema | null;
}

export type EvaluationSubmissionStore = ReturnType<typeof createPostgresEvaluationSubmissions>;
export type EvaluationSubmissionReceipt = "accepted" | "replayed" | "closed" | "conflict";

/** Validated MCP results are authoritative; Agent completion and resource collection are separate facts. */
export function createPostgresEvaluationSubmissions(db: EvalDb, runQueue: RunQueue) {
  return {
    async read(evaluationId: string): Promise<EvaluationStructuredOutput | undefined> {
      const [row] = await db.select().from(evaluationSubmissions).where(eq(evaluationSubmissions.evaluationId, evaluationId));
      return row ? { path: EVALUATION_SUBMISSION_PATH, content: row.content, contentHash: row.contentHash } : undefined;
    },
    async target(evaluationId: string): Promise<EvaluationSubmissionTarget | null> {
      const [row] = await db.select({ ownerUserId: evaluations.ownerUserId, projectId: samplings.projectId,
        status: sql<SamplingStatus>`${evaluations.facts}->'status'->>'status'`,
      }).from(evaluations).innerJoin(samplings, eq(samplings.samplingId, evaluations.samplingId))
        .where(eq(evaluations.evaluationId, evaluationId));
      if (!row) return null;
      return { ownerUserId: row.ownerUserId, status: row.status,
        schema: await readEvaluationOutputSchema(db, row.projectId, row.ownerUserId) };
    },
    /** Validation precedes this transaction; stop/replacement and acceptance share the Project lock. */
    async save(input: { readonly evaluationId: string; readonly ownerUserId: string; readonly content: string; readonly submittedAt: Date }): Promise<EvaluationSubmissionReceipt> {
      const contentHash = `sha256:${await sha256Hex(canonicalJsonBytes(JSON.parse(input.content)))}`;
      return db.transaction(async (tx) => {
        const [scope] = await tx.select({ projectId: samplings.projectId, execution: sql<SamplingStatus>`${samplings.facts}->'execution'->>'status'` }).from(evaluations)
          .innerJoin(samplings, eq(samplings.samplingId, evaluations.samplingId))
          .where(and(eq(evaluations.evaluationId, input.evaluationId), eq(evaluations.ownerUserId, input.ownerUserId)));
        if (!scope || scope.execution !== "succeeded") return "closed";
        const [project] = await tx.select({ id: projects.projectId }).from(projects)
          .where(and(eq(projects.projectId, scope.projectId), eq(projects.ownerUserId, input.ownerUserId), isNull(projects.deletedAt))).for("update");
        if (!project) return "closed";
        const [stored] = await tx.select({
          facts: evaluations.facts, samplingId: evaluations.samplingId,
        }).from(evaluations).where(and(eq(evaluations.evaluationId, input.evaluationId), eq(evaluations.ownerUserId, input.ownerUserId))).for("update");
        const evaluation = stored && { ...stored.facts, evaluationId: input.evaluationId, samplingId: stored.samplingId };
        if (!evaluation?.chatId || evaluation.status.status === "cancelled") return "closed";
        const [run] = await tx.select({ runId: runs.runId, stopped: runs.stopRequested }).from(runEvaluations)
          .innerJoin(runs, eq(runs.runId, runEvaluations.runId))
          .where(and(eq(runEvaluations.evaluationId, input.evaluationId), eq(runs.projectId, project.id)));
        if (!run || run.stopped) return "closed";
        const [existing] = await tx.select({ contentHash: evaluationSubmissions.contentHash, content: evaluationSubmissions.content }).from(evaluationSubmissions)
          .where(eq(evaluationSubmissions.evaluationId, input.evaluationId));
        if (existing && !equalJson(JSON.parse(existing.content), JSON.parse(input.content))) return "conflict";
        if (evaluation.status.status === "succeeded") return existing ? "replayed" : "closed";
        const structuredOutput: EvaluationStructuredOutput = { path: EVALUATION_SUBMISSION_PATH, content: existing?.content ?? input.content, contentHash: existing?.contentHash ?? contentHash, source: "submission" };
        const { error: _previousError, ...previousOutput } = evaluation.output ?? {};
        const output: EvaluationAgentOutput = {
          ...previousOutput,
          status: "succeeded",
          artifacts: evaluation.output?.artifacts ?? [],
          trajectory: evaluation.output?.trajectory ?? { trajectoryId: evaluation.chatId, source: "evaluator",
            path: `/api/chats/${encodeURIComponent(evaluation.chatId)}/trajectory` },
          structuredOutput,
        };
        const accepted = { ...evaluation, status: { status: "succeeded" as const }, output };
        const resourcesPending = evaluation.status.resourcesPending
          ?? (stageOwesResources(accepted.attempts, evaluationAgentEnded(accepted))
            ? startResourceWait(input.submittedAt.toISOString()) : undefined);
        const patch = JSON.stringify({ status: { ...accepted.status, ...(resourcesPending === undefined ? {} : { resourcesPending }) }, output });
        if (!existing) await tx.insert(evaluationSubmissions).values({ ...input, contentHash });
        await tx.update(evaluations).set({
          facts: sql`${evaluations.facts} || ${patch}::jsonb`,
          revision: sql`${evaluations.revision} + 1`,
        }).where(eq(evaluations.evaluationId, input.evaluationId));
        // Another member can finish before commit; only this locked target's old pending facts guarantee recovery.
        if (resourcesPending !== undefined && !isStageRecoveryPending(evaluation.status)) await runQueue.enqueue(tx, run.runId, "collection");
        return existing ? "replayed" : "accepted";
      });
    },
  };
}
