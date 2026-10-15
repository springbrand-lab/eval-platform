import { Pool } from "pg";
import pino from "pino";
import { createDatasetService } from "@eval-platform/eval-dataset";
import { createMetrics } from "@eval-platform/eval-metrics";
import { createConfigResolver, createEvalRunAdmission, type AgentOption } from "@eval-platform/eval-runtime";
import type { AgentRole } from "@eval-platform/eval-contracts";
import { createPostgresCatalog, createPostgresProjectCatalog } from "./db/catalog.js";
import { createEvalDb } from "./db/client.js";
import { createPostgresConfigReader, createPostgresConfigStore } from "./db/config.js";
import { createPostgresDatasetStore } from "./db/dataset.js";
import { createPostgresMetricsSource } from "./db/metrics.js";
import { requireEvalSpRelease } from "./db/release.js";
import { createPostgresRuntimeStore } from "./db/runtime.js";
import { createPostgresRuntimeQueries } from "./db/runtime-queries.js";
import { createEvalApiHandler } from "./http-api.js";
import { startEvalHttpServer } from "./http-server.js";
import { createPostgresIndependentEvaluationApi } from "./independent-evaluation-postgres.js";
import { createActiveOwnerAdmission } from "./active-owner-admission.js";
import { createInitialResourceHttpHandler } from "./initial-resources.http.js";
import { openBundleDirectory } from "./sp/bundle-directory.js";
import { createEvalSpClient } from "./sp/client.js";
import { startRunQueue } from "./run-worker-queue.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function apiPort(): number {
  const value = Number(process.env.EVAL_API_PORT ?? "8788");
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error("EVAL_API_PORT must be a TCP port number");
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const apiOrigin = requiredEnv("EVAL_SP_API_ORIGIN");
  const writeOrigin = requiredEnv("EVAL_SP_WRITE_ORIGIN");
  const release = requireEvalSpRelease({
    sourceBranch: requiredEnv("EVAL_SP_SOURCE_BRANCH"),
    sourceCommit: requiredEnv("EVAL_SP_SOURCE_COMMIT"),
  });
  const bundles = await openBundleDirectory(requiredEnv("EVAL_BUNDLE_DIR"));
  const pool = new Pool({ connectionString: databaseUrl });
  const runQueue = await startRunQueue(databaseUrl, pino({ level: "info", base: null }));
  try {
    const db = createEvalDb(pool);
    const sp = createEvalSpClient({ origin: apiOrigin, writeOrigin });
    const admissions = createActiveOwnerAdmission((ownerUserId: string) => createEvalRunAdmission({
      sourceCommit: release.sourceCommit,
      catalog: createPostgresProjectCatalog(db, ownerUserId, release),
      configResolver: createConfigResolver(createPostgresConfigReader(db, ownerUserId)),
      store: createPostgresRuntimeStore(db, ownerUserId, release, runQueue),
    }));
    const handler = createEvalApiHandler({
      sp,
      initialResources: createInitialResourceHttpHandler(db, bundles),
      independentEvaluation: createPostgresIndependentEvaluationApi({
        db, release, runQueue, spClient: sp,
        ...(process.env.EVAL_WEB_ORIGIN ? { webOrigin: process.env.EVAL_WEB_ORIGIN } : {}),
        onError: (error) => console.error(error),
      }),
      forOwner(ownerUserId, sessionToken) {
        const agents = {
          async listAgents(role?: AgentRole): Promise<readonly AgentOption[]> {
            const configs = await sp.listAgentConfigs(sessionToken);
            const roles: readonly AgentRole[] = role ? [role] : ["subject", "evaluator"];
            return configs.flatMap((config) => roles.map((selectedRole) => ({
              agentConfig: { ownerUserId, userAgentId: config.id },
              name: config.name,
              role: selectedRole,
            })));
          },
        };
        const catalog = createPostgresCatalog(db, ownerUserId, agents, release);
        const configs = createPostgresConfigStore(db, ownerUserId, sp, sessionToken);
        const datasets = createDatasetService(createPostgresDatasetStore(db, ownerUserId));
        const queries = createPostgresRuntimeQueries(db, ownerUserId);
        const metrics = createMetrics({ source: createPostgresMetricsSource(db, ownerUserId) });
        const { admission, release: releaseAdmission } = admissions.acquire(ownerUserId);
        const runtime = { ...admission, ...queries };
        return { datasets, catalog, configs, runtime, metrics, release: releaseAdmission };
      },
      onError: (error) => console.error(error),
    });
    const server = await startEvalHttpServer(handler, {
      host: process.env.EVAL_API_HOST ?? "127.0.0.1",
      port: apiPort(),
    });
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void server.close().then(() => runQueue.close()).then(() => pool.end()).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    await runQueue.close();
    await pool.end();
    throw error;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
