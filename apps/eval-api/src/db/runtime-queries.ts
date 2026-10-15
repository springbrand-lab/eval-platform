import type { EvalRuntime } from "@eval-platform/eval-runtime";
import { RuntimeRunNotFoundError, toSamplingSnapshot } from "@eval-platform/eval-runtime";
import type { RunQueue } from "../run-worker-queue.js";
import type { EvalDb } from "./client.js";
import { createPostgresProjectRunReader } from "./run-view.js";
import { createPostgresRuntimeStore } from "./runtime.js";
import type { EvalSpRelease } from "./release.js";

/** Owner-scoped result reads without a Worker Harness or mutable ConfigStore. */
export function createPostgresRuntimeQueries(
  db: EvalDb,
  ownerUserId: string,
  release: EvalSpRelease,
  runQueue: RunQueue,
): Pick<EvalRuntime, "getRun" | "getSampling" | "getEvaluation" | "listEvaluations"> {
  const store = createPostgresRuntimeStore(db, ownerUserId, release, runQueue);
  const readRun = createPostgresProjectRunReader(db, ownerUserId);
  return {
    async getRun(runId) {
      const record = await store.getRun(runId);
      if (!record) throw new RuntimeRunNotFoundError(runId);
      const view = await readRun(record.projectId, runId);
      if (!view) throw new RuntimeRunNotFoundError(runId);
      return view.run;
    },
    async getSampling(samplingId) {
      const record = await store.getSampling(samplingId);
      if (!record) throw new Error(`Unknown sampling ${samplingId}`);
      return toSamplingSnapshot(record);
    },
    async getEvaluation(evaluationId) {
      const record = await store.getEvaluation(evaluationId);
      if (!record) throw new Error(`Unknown evaluation ${evaluationId}`);
      return record;
    },
    async listEvaluations(samplingId) {
      return store.listEvaluations(samplingId);
    },
  };
}
