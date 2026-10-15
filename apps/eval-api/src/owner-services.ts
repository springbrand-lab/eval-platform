import { createDatasetService } from "@eval-platform/eval-dataset";
import { createMetrics } from "@eval-platform/eval-metrics";
import { createEvalRunAdmission, syncRunScores, type EvaluationScore } from "@eval-platform/eval-runtime";
import { createActiveOwnerAdmission } from "./active-owner-admission.js";
import { createAgentConfigService } from "./agent-configs.js";
import type { EvalDb } from "./db/client.js";
import { createPostgresDatasetStore } from "./db/dataset.js";
import { createPostgresMetricsSource } from "./db/metrics.js";
import { createPostgresObservationReader } from "./db/observation.js";
import { createOutputSchemaCatalog } from "./db/output-schemas.js";
import { createPostgresProjectPlanReader } from "./db/project-plans.js";
import { createPostgresProjectStore } from "./db/project-store.js";
import type { EvalSpRelease } from "./db/release.js";
import { createResourceCatalog } from "./db/resource-catalog.js";
import { createPostgresProjectRunReader } from "./db/run-view.js";
import { createPostgresProjectRunControl, createPostgresRuntimeStore } from "./db/runtime.js";
import { createPostgresRuntimeQueries } from "./db/runtime-queries.js";
import { createInitialResourceApi } from "./initial-resources.js";
import type { ApiRuntime } from "./lib/types.js";
import { createProjectService } from "./projects/service.js";
import type { BundleDirectory } from "./sp/bundle-directory.js";
import type { RunQueue } from "./run-worker-queue.js";
import type { EvalSpClient } from "./sp/client.js";

export interface OwnerServicesDependencies {
  readonly db: EvalDb;
  readonly sp: EvalSpClient;
  readonly bundles: BundleDirectory;
  readonly release: EvalSpRelease;
  readonly runQueue: RunQueue;
  /** Delivers one score to Langfuse; absent when Langfuse is not configured. */
  readonly publishScore?: (score: EvaluationScore) => Promise<void>;
}

/** The single composition of owner-scoped services; Run admission is shared while an owner has active requests. */
export function createOwnerServices({ db, sp, bundles, release, runQueue, publishScore }: OwnerServicesDependencies): ApiRuntime["ownerServices"] {
  const admissions = createActiveOwnerAdmission((ownerUserId) => createEvalRunAdmission({
    sourceCommit: release.sourceCommit,
    plans: createPostgresProjectPlanReader(db, ownerUserId),
    store: createPostgresRuntimeStore(db, ownerUserId, release, runQueue),
  }));
  return (user, sessionToken) => {
    const ownerUserId = user.id;
    const { admission, release: releaseAdmission } = admissions.acquire(ownerUserId);
    const projectStore = createPostgresProjectStore(db, ownerUserId);
    const outputSchemas = createOutputSchemaCatalog(db, ownerUserId);
    const agentConfigs = createAgentConfigService({ ownerUserId, sessionToken, sp, projects: projectStore });
    const readRun = createPostgresProjectRunReader(db, ownerUserId);
    const scores = publishScore === undefined ? undefined : {
      async syncRun(projectId: string, runId: string) {
        if (!await readRun(projectId, runId)) return null;
        return syncRunScores({
          store: createPostgresRuntimeStore(db, ownerUserId, release, runQueue),
          runId,
          publish: publishScore,
          now: () => new Date().toISOString(),
        });
      },
    };
    const services = {
      datasets: createDatasetService(createPostgresDatasetStore(db, ownerUserId)),
      projects: createProjectService({
        ownerUserId, sourceBranch: release.sourceBranch, store: projectStore, outputSchemas, agentConfigs, admission,
      }),
      agentConfigs,
      admission,
      results: createPostgresRuntimeQueries(db, ownerUserId),
      projectRuns: {
        ...createPostgresProjectRunControl(db, ownerUserId, runQueue),
        readRun,
      },
      observations: createPostgresObservationReader(db, ownerUserId),
      metrics: createMetrics({ source: createPostgresMetricsSource(db, ownerUserId) }),
      resources: createResourceCatalog(db, ownerUserId, bundles),
      outputSchemas,
      initialResources: createInitialResourceApi(db, ownerUserId, bundles),
      ...(scores === undefined ? {} : { scores }),
    };
    return { services, release: releaseAdmission };
  };
}
