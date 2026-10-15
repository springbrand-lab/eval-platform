import type { AgentRole } from "@eval-platform/eval-contracts";
import { createDatasetService } from "@eval-platform/eval-dataset";
import { createMetrics } from "@eval-platform/eval-metrics";
import { createConfigResolver, createEvalRunAdmission } from "@eval-platform/eval-runtime";
import { createActiveOwnerAdmission } from "./active-owner-admission.js";
import { createPostgresCatalog, createPostgresProjectCatalog } from "./db/catalog.js";
import type { EvalDb } from "./db/client.js";
import { createPostgresConfigReader, createPostgresConfigStore } from "./db/config.js";
import { createPostgresDatasetStore } from "./db/dataset.js";
import { createPostgresMetricsSource } from "./db/metrics.js";
import { createOutputSchemaCatalog } from "./db/output-schemas.js";
import type { EvalSpRelease } from "./db/release.js";
import { createResourceCatalog } from "./db/resource-catalog.js";
import { createPostgresProjectRunReader } from "./db/run-view.js";
import { createPostgresProjectRunControl, createPostgresRuntimeStore } from "./db/runtime.js";
import { createPostgresRuntimeQueries } from "./db/runtime-queries.js";
import { createInitialResourceApi } from "./initial-resources.js";
import type { ApiRuntime } from "./lib/types.js";
import type { BundleDirectory } from "./sp/bundle-directory.js";
import type { EvalSpClient } from "./sp/client.js";

const AGENT_ROLES: readonly AgentRole[] = ["subject", "evaluator"];

export interface OwnerServicesDependencies {
  readonly db: EvalDb;
  readonly sp: EvalSpClient;
  readonly bundles: BundleDirectory;
  readonly release: EvalSpRelease;
}

/** The single composition of owner-scoped services; Run admission is shared while an owner has active requests. */
export function createOwnerServices({ db, sp, bundles, release }: OwnerServicesDependencies): ApiRuntime["ownerServices"] {
  const admissions = createActiveOwnerAdmission((ownerUserId) => createEvalRunAdmission({
    sourceCommit: release.sourceCommit,
    catalog: createPostgresProjectCatalog(db, ownerUserId, release),
    configResolver: createConfigResolver(createPostgresConfigReader(db, ownerUserId)),
    store: createPostgresRuntimeStore(db, ownerUserId, release),
  }));
  return (user, sessionToken) => {
    const ownerUserId = user.id;
    const agents = {
      async listAgents(role?: AgentRole) {
        const configs = await sp.listAgentConfigs(sessionToken);
        return configs.flatMap((config) => (role ? [role] : AGENT_ROLES).map((selectedRole) => ({
          agentConfig: { ownerUserId, userAgentId: config.id },
          name: config.name,
          role: selectedRole,
        })));
      },
    };
    const services = {
      datasets: createDatasetService(createPostgresDatasetStore(db, ownerUserId)),
      catalog: createPostgresCatalog(db, ownerUserId, agents, release),
      configs: createPostgresConfigStore(db, ownerUserId, sp, sessionToken),
      results: createPostgresRuntimeQueries(db, ownerUserId, release),
      projectRuns: {
        ...createPostgresProjectRunControl(db, ownerUserId),
        readRun: createPostgresProjectRunReader(db, ownerUserId),
      },
      metrics: createMetrics({ source: createPostgresMetricsSource(db, ownerUserId) }),
      resources: createResourceCatalog(db, ownerUserId, bundles),
      outputSchemas: createOutputSchemaCatalog(db, ownerUserId),
      initialResources: createInitialResourceApi(db, ownerUserId, bundles),
    };
    const { admission, release: releaseAdmission } = admissions.acquire(ownerUserId);
    return { services: { ...services, admission }, release: releaseAdmission };
  };
}
