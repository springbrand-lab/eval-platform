import { RuntimeEntityNotFoundError } from "./errors.js";
import type { EvalRuntime } from "./model.js";
import { toRunSnapshot, toSamplingSnapshot } from "./projection.js";
import type { RunRecords } from "./records.js";
import type { RuntimeStore } from "./store.js";

type RunQueries = Pick<EvalRuntime, "getRun" | "getSampling" | "getEvaluation" | "listEvaluations">;

/** Detached, projected reads of persisted Run, Sampling and Evaluation facts. */
export function createRunQueries(store: RuntimeStore, records: RunRecords): RunQueries {
  return {
    async getRun(runId) {
      const run = await store.getRun(runId);
      if (!run) throw new RuntimeEntityNotFoundError("run", runId);
      const samplings = await records.samplings(run.samplingIds);
      const evaluations = await records.evaluations(run.evaluationIds);
      return toRunSnapshot(run, samplings, evaluations);
    },
    async getSampling(samplingId) {
      const sampling = await store.getSampling(samplingId);
      if (!sampling) throw new RuntimeEntityNotFoundError("sampling", samplingId);
      return toSamplingSnapshot(sampling);
    },
    async getEvaluation(evaluationId) {
      const evaluation = await store.getEvaluation(evaluationId);
      if (!evaluation) throw new RuntimeEntityNotFoundError("evaluation", evaluationId);
      return structuredClone(evaluation);
    },
    async listEvaluations(samplingId) {
      return structuredClone(await store.listEvaluations(samplingId));
    },
  };
}
