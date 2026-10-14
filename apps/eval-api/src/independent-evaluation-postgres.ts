import {
  createConfigResolver,
  createEvalRunAdmission,
} from "@eval-platform/eval-runtime";
import { createPostgresCatalog } from "./db/catalog.js";
import type { EvalDb } from "./db/client.js";
import { createPostgresConfigReader } from "./db/config.js";
import { requireEvalSpRelease, type EvalSpRelease } from "./db/release.js";
import { createPostgresProjectRunReader } from "./db/run-view.js";
import { createPostgresRuntimeStore } from "./db/runtime.js";
import {
  createIndependentEvaluationApi,
  type IndependentEvaluationApi,
  type IndependentEvaluationApiOptions,
} from "./independent-evaluation-api.js";

export interface PostgresIndependentEvaluationApiOptions extends Omit<IndependentEvaluationApiOptions, "createOwnerServices"> {
  readonly db: EvalDb;
  readonly release: EvalSpRelease;
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
      const catalog = createPostgresCatalog(options.db, ownerUserId, {
        async listAgents() {
          throw new Error("Agent listing is not part of the independent evaluation API");
        },
      }, release);
      const runtime = createEvalRunAdmission({
        sourceCommit: release.sourceCommit,
        catalog,
        configResolver: createConfigResolver(configStore),
        store: createPostgresRuntimeStore(options.db, ownerUserId, release),
      });
      return {
        catalog,
        runtime,
        readRun: createPostgresProjectRunReader(options.db, ownerUserId),
      };
    },
  });
}
