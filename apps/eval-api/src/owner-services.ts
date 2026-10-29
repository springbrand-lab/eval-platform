import { createDatasetService } from "@eval-platform/eval-dataset";
import { createMetrics, createEvaluationScoreReader, createProjectComparison } from "@eval-platform/eval-metrics";
import { createEvalRunAdmission, syncRunScores, type EvaluationScore } from "@eval-platform/eval-runtime";
import { createActiveOwnerAdmission } from "./active-owner-admission.js";
import { createAgentConfigService } from "./agent-configs.js";
import { createAgentImportService, createAgentImportTaskReader } from "./agent-imports/service.js";
import type { AgentImportSource } from "./agent-imports/source.js";
import type { AgentImportTarget } from "./agent-imports/target.js";
import type { AgentImportQueue } from "./agent-import-queue.js";
import { createPostgresAgentImportStore, createPostgresAgentImportTaskReader } from "./db/agent-imports.js";
import { createPostgresResourceSourceStore } from "./db/agent-import-sources.js";
import { createPostgresResourceSnapshotReader } from "./db/attempt-resources.js";
import type { EvalDb } from "./db/client.js";
import { createPostgresDatasetStore } from "./db/dataset.js";
import { createPostgresDashboardStore } from "./db/dashboards.js";
import { createPostgresAgentPurposeStore } from "./db/agent-purposes.js";
import { createPostgresMetricsSource, createPostgresProjectComparisonSource } from "./db/metrics.js";
import { createPostgresObservationReader } from "./db/observation.js";
import { createOutputSchemaCatalog } from "./db/output-schemas.js";
import { createPostgresProjectPlanReader } from "./db/project-plans.js";
import { createPostgresProjectResultsSource } from "./db/project-results.js";
import { createPostgresProjectStore } from "./db/project-store.js";
import type { EvalSpRelease } from "./db/release.js";
import { createBundleCatalogs } from "./db/resource-catalog.js";
import { createPostgresProjectRunReader } from "./db/run-view.js";
import { createPostgresProjectRunControl, createPostgresRuntimeStore } from "./db/runtime.js";
import { createPostgresRuntimeQueries } from "./db/runtime-queries.js";
import { createInitialResourceApi } from "./initial-resources.js";
import { createDashboardService } from "./dashboards/service.js";
import type { ApiRuntime } from "./lib/types.js";
import { createProjectService } from "./projects/service.js";
import { createProjectResultsExport } from "./projects/evaluation-results.js";
import type { BundleDirectory } from "./sp/bundle-directory.js";
import type { RunQueue } from "./run-worker-queue.js";
import type { EvalSpClient } from "./sp/client.js";

export interface OwnerServicesDependencies {
  readonly db: EvalDb;
  readonly sp: EvalSpClient;
  readonly bundles: BundleDirectory;
  readonly release: EvalSpRelease;
  readonly runQueue: RunQueue;
  readonly agentImportTarget?: AgentImportTarget;
  readonly agentImports?: { readonly source: AgentImportSource; readonly queue: AgentImportQueue };
  /** Delivers one score to Langfuse; absent when Langfuse is not configured. */
  readonly publishScore?: (score: EvaluationScore) => Promise<void>;
}

/** The single composition of owner-scoped services; Run admission is shared while an owner has active requests. */
export function createOwnerServices({ db, sp, bundles, release, runQueue, publishScore, agentImportTarget, agentImports }: OwnerServicesDependencies): ApiRuntime["ownerServices"] {
  const admissions = createActiveOwnerAdmission((ownerUserId) => createEvalRunAdmission({
    sourceCommit: release.sourceCommit,
    plans: createPostgresProjectPlanReader(db, ownerUserId),
    store: createPostgresRuntimeStore(db, ownerUserId, release, runQueue),
  }));
  return (user, sessionToken) => {
    const ownerUserId = user.id;
    const { admission, release: releaseAdmission } = admissions.acquire(ownerUserId);
    try {
      const projectStore = createPostgresProjectStore(db, ownerUserId);
      const outputSchemas = createOutputSchemaCatalog(db, ownerUserId);
      const agentConfigs = createAgentConfigService({
        ownerUserId, sessionToken, sp, projects: projectStore, purposes: createPostgresAgentPurposeStore(db, ownerUserId),
        sources: createPostgresResourceSourceStore(db, ownerUserId),
        ...(agentImportTarget === undefined ? {} : { imports: agentImportTarget }),
      });
      const readRun = createPostgresProjectRunReader(db, ownerUserId);
      const scores = publishScore === undefined ? undefined : {
        async syncRun(projectId: string, runId: string) {
          if (!await readRun(projectId, runId)) return null;
          const plans = createPostgresProjectPlanReader(db, ownerUserId);
          const schema = await plans.getEvaluationOutputSchema(projectId);
          if (!schema) return null;
          return syncRunScores({
            store: createPostgresRuntimeStore(db, ownerUserId, release, runQueue),
            runId,
            publish: publishScore,
            read: createEvaluationScoreReader(),
            schema,
            now: () => new Date().toISOString(),
          });
        },
      };
      const services = {
        datasets: createDatasetService(createPostgresDatasetStore(db, ownerUserId)),
        projects: createProjectService({
          ownerUserId, sourceBranch: release.sourceBranch, store: projectStore, outputSchemas, agentConfigs, admission,
        }),
        projectResultsExport: createProjectResultsExport(createPostgresProjectResultsSource(db, ownerUserId)),
        agentConfigs,
        agentImportTasks: createAgentImportTaskReader(createPostgresAgentImportTaskReader(db, ownerUserId)),
        ...(agentImports === undefined || agentImportTarget === undefined ? {} : { agentImports: createAgentImportService({
          source: agentImports.source, target: agentImportTarget,
          store: createPostgresAgentImportStore(db, ownerUserId, agentImports.queue),
        }) }),
        admission,
        results: createPostgresRuntimeQueries(db, ownerUserId),
        projectRuns: {
          ...createPostgresProjectRunControl(db, ownerUserId, runQueue),
          readRun,
        },
        observations: createPostgresObservationReader(db, ownerUserId),
        resourceSnapshots: createPostgresResourceSnapshotReader(db, ownerUserId),
        metrics: createMetrics({ source: createPostgresMetricsSource(db, ownerUserId) }),
        comparison: createProjectComparison({ source: createPostgresProjectComparisonSource(db, ownerUserId) }),
        dashboards: createDashboardService(createPostgresDashboardStore(db, ownerUserId)),
        ...createBundleCatalogs(db, ownerUserId, bundles),
        outputSchemas,
        initialResources: createInitialResourceApi(db, ownerUserId),
        ...(scores === undefined ? {} : { scores }),
      };
      return { services, release: releaseAdmission };
    } catch (error) {
      releaseAdmission();
      throw error;
    }
  };
}
