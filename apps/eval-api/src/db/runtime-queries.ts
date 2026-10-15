import type { EvalRuntime } from "@eval-platform/eval-runtime";
import { RuntimeEntityNotFoundError, toSamplingSnapshot } from "@eval-platform/eval-runtime";
import type { EvalDb } from "./client.js";
import { requireOwnerUserId } from "./owner.js";
import { listSamplingEvaluations, readEvaluations, readSamplings } from "./run-records.js";
import { readRunView } from "./run-view.js";

/** Owner-scoped result reads without a Worker Harness or mutable ConfigStore. */
export function createPostgresRuntimeQueries(
  db: EvalDb,
  ownerUserId: string,
): Pick<EvalRuntime, "getRun" | "getSampling" | "getEvaluation" | "listEvaluations"> {
  const owner = requireOwnerUserId(ownerUserId);
  return {
    async getRun(runId) {
      const view = await db.transaction(
        (transaction) => readRunView(transaction, runId, { kind: "owner", ownerUserId: owner }),
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
      if (!view) throw new RuntimeEntityNotFoundError("run", runId);
      return view.run;
    },
    async getSampling(samplingId) {
      const [record] = await readSamplings(db, [samplingId], owner);
      if (!record) throw new RuntimeEntityNotFoundError("sampling", samplingId);
      return toSamplingSnapshot(record);
    },
    async getEvaluation(evaluationId) {
      const [record] = await readEvaluations(db, [evaluationId], owner);
      if (!record) throw new RuntimeEntityNotFoundError("evaluation", evaluationId);
      return record;
    },
    listEvaluations(samplingId) {
      return listSamplingEvaluations(db, samplingId, owner);
    },
  };
}
