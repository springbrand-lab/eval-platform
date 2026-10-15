import type { EvaluationRecord, Sampling } from "@eval-platform/eval-contracts";
import type { EvalRunQueries } from "@eval-platform/eval-runtime";
import { RuntimeEntityNotFoundError, toSamplingSnapshot } from "@eval-platform/eval-runtime";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { projectExists, READ_SNAPSHOT } from "./project-plans.js";
import { listSamplingEvaluations, readEvaluations, readSamplings, type RecordReader } from "./run-records.js";
import { readRunView } from "./run-view.js";

/** Owner-scoped result reads without a Worker Harness; records of soft-deleted Projects read as missing. */
export function createPostgresRuntimeQueries(db: EvalDb, ownerUserId: string): EvalRunQueries {
  const owner = requireOwnerUserId(ownerUserId);
  async function findSampling(reader: RecordReader, samplingId: string): Promise<Sampling | null> {
    const [record] = await readSamplings(reader, [samplingId], owner);
    return record && await projectExists(reader, record.projectId, owner) ? record : null;
  }
  async function visibleSampling(reader: RecordReader, samplingId: string): Promise<Sampling> {
    const record = await findSampling(reader, samplingId);
    if (!record) throw new RuntimeEntityNotFoundError("sampling", samplingId);
    return record;
  }
  return {
    async getRun(runId) {
      const view = await db.transaction(
        (transaction) => readRunView(transaction, runId, { kind: "owner", ownerUserId: owner }), READ_SNAPSHOT);
      if (!view) throw new RuntimeEntityNotFoundError("run", runId);
      return view.run;
    },
    async getSampling(samplingId) {
      return toSamplingSnapshot(await db.transaction((transaction) => visibleSampling(transaction, samplingId), READ_SNAPSHOT));
    },
    getEvaluation(evaluationId) {
      return db.transaction(async (transaction): Promise<EvaluationRecord> => {
        const [record] = await readEvaluations(transaction, [evaluationId], owner);
        if (!record || !await findSampling(transaction, record.samplingId)) {
          throw new RuntimeEntityNotFoundError("evaluation", evaluationId);
        }
        return record;
      }, READ_SNAPSHOT);
    },
    listEvaluations(samplingId) {
      return db.transaction(async (transaction) => {
        await visibleSampling(transaction, samplingId);
        return listSamplingEvaluations(transaction, samplingId, owner);
      }, READ_SNAPSHOT);
    },
  };
}
