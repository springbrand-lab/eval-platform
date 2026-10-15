import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { DatasetService } from "@eval-platform/eval-dataset";
import type { Metrics } from "@eval-platform/eval-metrics";
import type { EvalRunAdmission, EvalRunQueries } from "@eval-platform/eval-runtime";
import type { Env as PinoEnv } from "hono-pino";
import type { AgentConfigService } from "../agent-configs.js";
import type { createPostgresObservationReader } from "../db/observation.js";
import type { createOutputSchemaCatalog } from "../db/output-schemas.js";
import type { createResourceCatalog } from "../db/resource-catalog.js";
import type { ProjectRunView } from "../db/run-view.js";
import type { createPostgresProjectRunControl } from "../db/runtime.js";
import type { InitialResourceApi } from "../initial-resources.js";
import type { ProjectService } from "../projects/service.js";
import type { EvalSpClient, EvalSpUser } from "../sp/client.js";

/** Every service a request may use, already scoped to the verified Eval SP user. */
export interface OwnerServices {
  readonly datasets: DatasetService;
  readonly projects: ProjectService;
  readonly agentConfigs: AgentConfigService;
  readonly admission: EvalRunAdmission;
  readonly results: EvalRunQueries;
  readonly projectRuns: ReturnType<typeof createPostgresProjectRunControl> & {
    readRun(projectId: string, runId: string): Promise<ProjectRunView | null>;
  };
  readonly observations: ReturnType<typeof createPostgresObservationReader>;
  readonly metrics: Metrics;
  readonly resources: ReturnType<typeof createResourceCatalog>;
  readonly outputSchemas: ReturnType<typeof createOutputSchemaCatalog>;
  readonly initialResources: InitialResourceApi;
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
