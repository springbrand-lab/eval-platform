import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { DatasetService } from "@eval-platform/eval-dataset";
import type { Metrics } from "@eval-platform/eval-metrics";
import type { EvalRunAdmission, EvalRunQueries } from "@eval-platform/eval-runtime";
import type { Env as PinoEnv } from "hono-pino";
import type { AgentConfigService } from "../agent-configs.js";
import type { AgentImportService, AgentImportTaskReader } from "../agent-imports/service.js";
import type { createPostgresResourceSnapshotReader } from "../db/attempt-resources.js";
import type { createPostgresObservationReader } from "../db/observation.js";
import type { createOutputSchemaCatalog } from "../db/output-schemas.js";
import type { EvaluationSubmissionStore } from "../db/evaluation-submissions.js";
import type { ManagementFiles } from "../eval-management/files.js";
import type { ManagementStore } from "../eval-management/store.js";
import type { BundleCatalogs } from "../db/resource-catalog.js";
import type { ProjectRunView } from "../db/run-view.js";
import type { createPostgresProjectRunControl } from "../db/runtime.js";
import type { InitialResourceApi } from "../initial-resources.js";
import type { ProjectService } from "../projects/service.js";
import type { ProjectResultsExport } from "../projects/evaluation-results.js";
import type { EvalSpClient, EvalSpUser } from "../sp/client.js";
import type { ScoreSyncSummary } from "@eval-platform/eval-runtime";
import type { SpObservationClient } from "../sp/observation.js";

/** Every service a request may use, already scoped to the Eval SP service account. */
export interface OwnerServices {
  readonly datasets: DatasetService;
  readonly projects: ProjectService;
  readonly projectResultsExport: ProjectResultsExport;
  readonly agentConfigs: AgentConfigService;
  /** Always available: persisted owner-scoped progress, independent of optional import mutations. */
  readonly agentImportTasks: AgentImportTaskReader;
  /** Absent when the optional authorized dev export connection is not configured. */
  readonly agentImports?: AgentImportService;
  readonly admission: EvalRunAdmission;
  readonly results: EvalRunQueries;
  readonly projectRuns: ReturnType<typeof createPostgresProjectRunControl> & {
    readRun(projectId: string, runId: string): Promise<ProjectRunView | null>;
  };
  readonly observations: ReturnType<typeof createPostgresObservationReader>;
  readonly resourceSnapshots: ReturnType<typeof createPostgresResourceSnapshotReader>;
  readonly metrics: Metrics;
  readonly materialBundles: BundleCatalogs["materialBundles"];
  readonly sessionBundles: BundleCatalogs["sessionBundles"];
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

export interface WebActor {
  readonly id: string;
  readonly name: string;
}

/** Process-wide dependencies passed to every request as Hono bindings. */
export interface ApiRuntime {
  /** The Eval Web origin: the only browser origin allowed to call this API. */
  readonly webOrigin: string;
  /** Shared with the eval-web Worker; absent in local development. */
  readonly webApiToken?: string;
  readonly sp: EvalSpClient;
  /** Read-only views of the service account's Eval SP Chats. */
  readonly observation: SpObservationClient;
  /** The fixed Eval SP account and its long-lived session, verified once at startup. */
  readonly serviceAccount: { readonly user: EvalSpUser; readonly email: string; readonly sessionToken: string };
  /** The Eval SP RESOURCE_ADMIN_TOKEN; only credit grants to the service account use it. */
  readonly spAdminToken: string;
  readonly ownerServices: (user: EvalSpUser, sessionToken: string) => OwnerServicesLease;
  /** The Evaluator result submission MCP Server; absent when EVAL_RESULT_MCP_TOKEN is not set. */
  readonly evaluationResults?: {
    readonly token: string;
    readonly submissions: Pick<EvaluationSubmissionStore, "target" | "save">;
  };
  /** The trusted Moss management MCP; absent unless its independent Secret is set. */
  readonly evalManagement?: {
    readonly token: string;
    readonly files: ManagementFiles;
    readonly store: ManagementStore;
    readonly spOrigin: string;
  };
}

export type AppBindings = {
  Bindings: ApiRuntime;
  Variables: {
    user: EvalSpUser;
    sessionToken: string;
    services: OwnerServices;
    /** The takt user behind an eval-web request, for audit only; never an owner. */
    actor?: WebActor;
  };
} & PinoEnv;

export type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, AppBindings>;
