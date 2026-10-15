import type { AgentObservationRef } from "@eval-platform/eval-contracts";
import { RuntimeEntityNotFoundError } from "@eval-platform/eval-runtime";
import { and, eq } from "drizzle-orm";
import { READ_SNAPSHOT, type EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { projectExists } from "./project-plans.js";
import { evaluationFromRow, samplingFromRow } from "./run-records.js";
import { evaluations, samplings } from "./schema.js";

function state(chatId: string | undefined, attempts: readonly unknown[]): AgentObservationRef["state"] {
  return chatId !== undefined && attempts.length > 0 ? "available" : "not-started";
}

/**
 * Resolves read-only observation targets for current Samplings and Evaluations of a non-deleted
 * owned Project. Replaced records are gone and read as missing; no writable Chat URL is produced.
 */
export function createPostgresObservationReader(db: EvalDb, ownerUserId: string) {
  const owner = requireOwnerUserId(ownerUserId);
  async function requireProject(reader: Pick<EvalDb, "select">, projectId: string): Promise<void> {
    if (!await projectExists(reader, projectId, owner)) throw new RuntimeEntityNotFoundError("project", projectId);
  }
  return {
    subject(projectId: string, samplingId: string): Promise<AgentObservationRef> {
      return db.transaction(async (transaction) => {
        await requireProject(transaction, projectId);
        const [row] = await transaction.select().from(samplings).where(and(eq(samplings.ownerUserId, owner),
          eq(samplings.projectId, projectId), eq(samplings.samplingId, samplingId)));
        if (!row) throw new RuntimeEntityNotFoundError("sampling", samplingId);
        const sampling = samplingFromRow(row);
        return {
          role: "subject", projectId, samplingId,
          ownerUserId: sampling.subjectAgent.ownerUserId,
          ...(sampling.subjectChatId === undefined ? {} : { chatId: sampling.subjectChatId }),
          state: state(sampling.subjectChatId, sampling.executionAttempts),
        };
      }, READ_SNAPSHOT);
    },
    evaluator(projectId: string, evaluationId: string): Promise<AgentObservationRef> {
      return db.transaction(async (transaction) => {
        await requireProject(transaction, projectId);
        const [row] = await transaction.select({ evaluation: evaluations }).from(evaluations)
          .innerJoin(samplings, and(eq(samplings.ownerUserId, evaluations.ownerUserId), eq(samplings.samplingId, evaluations.samplingId)))
          .where(and(eq(evaluations.ownerUserId, owner), eq(samplings.projectId, projectId), eq(evaluations.evaluationId, evaluationId)));
        if (!row) throw new RuntimeEntityNotFoundError("evaluation", evaluationId);
        const evaluation = evaluationFromRow(row.evaluation);
        return {
          role: "evaluator", projectId, samplingId: evaluation.samplingId, evaluationId,
          ownerUserId: evaluation.evaluator.ownerUserId,
          ...(evaluation.chatId === undefined ? {} : { chatId: evaluation.chatId }),
          state: state(evaluation.chatId, evaluation.attempts),
        };
      }, READ_SNAPSHOT);
    },
  };
}
