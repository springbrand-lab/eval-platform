import {
  createConfigResolver,
  createEvalRunAdmission,
} from "@eval-platform/eval-runtime";
import { createPostgresProjectCatalog } from "./db/catalog.js";
import type { EvalDb } from "./db/client.js";
import { createPostgresConfigReader } from "./db/config.js";
import { requireEvalSpRelease, type EvalSpRelease } from "./db/release.js";
import { createPostgresProjectRunReader } from "./db/run-view.js";
import { createPostgresProjectRunControl, createPostgresRuntimeStore } from "./db/runtime.js";
import type { RunQueue } from "./run-worker-queue.js";
import {
  createIndependentEvaluationApi,
  type IndependentEvaluationApi,
  type IndependentEvaluationApiOptions,
} from "./independent-evaluation-api.js";

export interface PostgresIndependentEvaluationApiOptions extends Omit<IndependentEvaluationApiOptions, "createOwnerServices"> {
  readonly db: EvalDb;
  readonly release: EvalSpRelease;
  readonly runQueue: RunQueue;
}

/** Wires the authenticated route set to owner-scoped PostgreSQL and Runtime services. */
export function createPostgresIndependentEvaluationApi(
  options: PostgresIndependentEvaluationApiOptions,
): IndependentEvaluationApi {
  const release = requireEvalSpRelease(options.release);
  return createIndependentEvaluationApi({
    spClient: options.spClient,
    ...(options.webOrigin === undefined ? {} : { webOrigin: options.webOrigin }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    createOwnerServices(ownerUserId) {
      const configStore = createPostgresConfigReader(options.db, ownerUserId);
      const catalog = createPostgresProjectCatalog(options.db, ownerUserId, release);
      const runControl = createPostgresProjectRunControl(options.db, ownerUserId, options.runQueue);
      const runtime = createEvalRunAdmission({
        sourceCommit: release.sourceCommit,
        catalog,
        configResolver: createConfigResolver(configStore),
        store: createPostgresRuntimeStore(options.db, ownerUserId, release, options.runQueue),
      });
      return {
        catalog,
        runtime,
        readRun: createPostgresProjectRunReader(options.db, ownerUserId),
        getCurrentRun: runControl.getCurrentRun,
        stopRun: runControl.stopRun,
      };
    },
  });
}
