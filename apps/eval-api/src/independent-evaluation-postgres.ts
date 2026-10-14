import {
  createConfigResolver,
  createEvalRuntime,
  type ConfigStore,
  type Harness,
} from "@eval-platform/eval-runtime";
import { and, eq } from "drizzle-orm";
import { createPostgresCatalog } from "./db/catalog.js";
import type { EvalDb } from "./db/client.js";
import { createPostgresConfigReader } from "./db/config.js";
import { createPostgresRuntimeStore, evaluationFromRow } from "./db/runtime.js";
import { evaluations, runEvaluations, runs } from "./db/schema.js";
import {
  createIndependentEvaluationApi,
  type IndependentEvaluationApi,
  type IndependentEvaluationApiOptions,
} from "./independent-evaluation-api.js";

export interface PostgresIndependentEvaluationApiOptions extends Omit<IndependentEvaluationApiOptions, "createOwnerServices"> {
  readonly db: EvalDb;
  /** The ConfigStore must only return configuration owned by this verified user. */
  readonly configStoreForOwner?: (ownerUserId: string) => ConfigStore | Promise<ConfigStore>;
  readonly harness: Harness;
}

/** Wires the authenticated route set to owner-scoped PostgreSQL and Runtime services. */
export function createPostgresIndependentEvaluationApi(
  options: PostgresIndependentEvaluationApiOptions,
): IndependentEvaluationApi {
  return createIndependentEvaluationApi({
    spClient: options.spClient,
    ...(options.webOrigin === undefined ? {} : { webOrigin: options.webOrigin }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    async createOwnerServices(ownerUserId) {
      const configStore = await (options.configStoreForOwner?.(ownerUserId)
        ?? createPostgresConfigReader(options.db, ownerUserId));
      const catalog = createPostgresCatalog(options.db, ownerUserId, {
        async listAgents() {
          throw new Error("Agent listing is not part of the independent evaluation API");
        },
      });
      const runtime = createEvalRuntime({
        catalog,
        configResolver: createConfigResolver(configStore),
        harness: options.harness,
        store: createPostgresRuntimeStore(options.db, ownerUserId),
      });
      return {
        catalog,
        runtime,
        async listRunEvaluations(projectId, runId) {
          const rows = await options.db.select({
            evaluationId: evaluations.evaluationId,
            samplingId: evaluations.samplingId,
            facts: evaluations.facts,
          }).from(runEvaluations)
            .innerJoin(runs, eq(runEvaluations.runId, runs.runId))
            .innerJoin(evaluations, eq(runEvaluations.evaluationId, evaluations.evaluationId))
            .where(and(
              eq(runs.ownerUserId, ownerUserId),
              eq(runs.projectId, projectId),
              eq(runs.runId, runId),
            ))
            .orderBy(runEvaluations.position);
          return rows.map(evaluationFromRow);
        },
      };
    },
  });
}
