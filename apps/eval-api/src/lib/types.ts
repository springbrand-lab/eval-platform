import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { DatasetService } from "@eval-platform/eval-dataset";
import type { Metrics } from "@eval-platform/eval-metrics";
import type { EvalRunAdmission, EvalRunQueries } from "@eval-platform/eval-runtime";
import type { Env as PinoEnv } from "hono-pino";
import type { PostgresCatalog } from "../db/catalog.js";
import type { PostgresConfigStore } from "../db/config.js";
import type { createOutputSchemaCatalog } from "../db/output-schemas.js";
import type { createResourceCatalog } from "../db/resource-catalog.js";
import type { ProjectRunView } from "../db/run-view.js";
import type { createPostgresProjectRunControl } from "../db/runtime.js";
import type { InitialResourceApi } from "../initial-resources.js";
import type { EvalSpClient, EvalSpUser } from "../sp/client.js";
import type { ScoreSyncSummary } from "@eval-platform/eval-runtime";

/** Every service a request may use, already scoped to the Eval SP service account. */
export interface OwnerServices {
  readonly datasets: DatasetService;
  readonly catalog: PostgresCatalog;
  readonly configs: PostgresConfigStore;
  readonly admission: EvalRunAdmission;
  readonly results: EvalRunQueries;
  readonly projectRuns: ReturnType<typeof createPostgresProjectRunControl> & {
    readRun(projectId: string, runId: string): Promise<ProjectRunView | null>;
  };
  readonly metrics: Metrics;
  readonly resources: ReturnType<typeof createResourceCatalog>;
  readonly outputSchemas: ReturnType<typeof createOutputSchemaCatalog>;
  readonly initialResources: InitialResourceApi;
  /** Absent when Langfuse is not configured. */
  readonly scores?: {
    syncRun(projectId: string, runId: string): Promise<ScoreSyncSummary | null>;
  };
}

/** Holds owner services for one request; `release` frees the shared per-owner admission. */
export interface OwnerServicesLease {
  readonly services: OwnerServices;
  readonly release: () => void;
}

/** Process-wide dependencies passed to every request as Hono bindings. */
export interface ApiRuntime {
  /** The Eval Web origin: the only browser origin allowed to call this API. */
  readonly webOrigin: string;
  readonly sp: EvalSpClient;
  /** The fixed Eval SP account and its long-lived session, verified once at startup. */
  readonly serviceAccount: { readonly user: EvalSpUser; readonly email: string; readonly sessionToken: string };
  /** The Eval SP RESOURCE_ADMIN_TOKEN; only credit grants to the service account use it. */
  readonly spAdminToken: string;
  readonly ownerServices: (user: EvalSpUser, sessionToken: string) => OwnerServicesLease;
}

export type AppBindings = {
  Bindings: ApiRuntime;
  Variables: {
    user: EvalSpUser;
    sessionToken: string;
    services: OwnerServices;
  };
} & PinoEnv;

export type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, AppBindings>;
