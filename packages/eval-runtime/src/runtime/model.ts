import type { Data, Dataset } from "@eval-platform/eval-dataset";
import type {
  AgentConfigRef,
  AgentRole,
  ArtifactRef,
  EvaluationOutputSchema,
  EvaluationRecord,
  EvaluateRequest,
  ExecutionAttempt,
  PipelineRequest,
  Project,
  RunHandle,
  RunSnapshot,
  Sampling,
  SamplingStageState,
  StartRunRequest,
  TrajectoryRef,
} from "@eval-platform/eval-contracts";
import type {
  ConfigResolver,
} from "../config/index.js";

import type { Harness } from "../harness/index.js";
import type { RetryController } from "./retry.js";
import type { SamplingState, RuntimeStore } from "./store.js";

export interface Sample {
  readonly sampleId: string;
  readonly data: Data;
}

export interface RuntimeSamplingContext {
  readonly state: SamplingState;
  readonly sample: Sample;
}

export interface RuntimeEvaluationContext {
  readonly sampling: SamplingState;
  readonly evaluation: EvaluationRecord;
  readonly sample: Sample;
}

export interface SamplingSnapshot {
  readonly samplingId: Sampling["samplingId"];
  readonly projectId: Sampling["projectId"];
  readonly sampleId: Sampling["sampleId"];
  readonly execution: SamplingStageState;
  readonly subjectAgent: Sampling["subjectAgent"];
  readonly subjectChatId?: Sampling["subjectChatId"];
  readonly executionAttempts: readonly ExecutionAttempt[];
  readonly artifacts?: readonly ArtifactRef[];
  readonly trajectory?: TrajectoryRef;
}

export interface AgentOption {
  readonly agentConfig: AgentConfigRef;
  readonly name: string;
  readonly role: AgentRole;
}

export interface RuntimeCatalog {
  listProjects(): Promise<readonly Project[]>;
  /** Resolve the Project's output-format ID to its immutable Schema for Worker use. */
  getProject(projectId: string): Promise<(Project & { readonly evaluationOutputSchema?: EvaluationOutputSchema }) | null>;
  listAgents(role?: AgentRole): Promise<readonly AgentOption[]>;
  listDatasets(): Promise<readonly Dataset[]>;
  listData(datasetId: string): Promise<readonly Data[]>;
  listSamples(dataId: string): Promise<readonly Sample[]>;
  getSample(sampleId: string): Promise<Sample | null>;
  /** Return one Sample or null per input ID, in the same order. */
  getSamples(sampleIds: readonly string[]): Promise<readonly (Sample | null)[]>;
}

/** Catalog reads needed to resolve a new Run; no Agent listing or UI queries. */
export type RuntimeAdmissionCatalog = Pick<RuntimeCatalog, "listData" | "listSamples" | "getSamples">;

export interface EvalRuntime {
  listProjects(): Promise<readonly Project[]>;
  listAgents(role?: AgentRole): Promise<readonly AgentOption[]>;
  listDatasets(): Promise<readonly Dataset[]>;
  listData(datasetId: string): Promise<readonly Data[]>;
  listSamples(dataId: string): Promise<readonly Sample[]>;
  start(request: StartRunRequest): Promise<RunHandle>;
  evaluate(request: EvaluateRequest): Promise<RunHandle>;
  pipeline(request: PipelineRequest): Promise<RunHandle>;
  resume(runId: string): Promise<void>;
  getRun(runId: string): Promise<RunSnapshot>;
  getSampling(samplingId: string): Promise<SamplingSnapshot>;
  getEvaluation(evaluationId: string): Promise<EvaluationRecord>;
  listEvaluations(samplingId: string): Promise<readonly EvaluationRecord[]>;
}

export interface EvalRuntimeDependencies {
  /** Resolved SP source commit of this Eval deployment; saved on newly admitted Runs. */
  readonly sourceCommit: string;
  readonly catalog: RuntimeCatalog;
  readonly configResolver: ConfigResolver;
  readonly harness: Harness;
  readonly store: RuntimeStore;
  readonly createRetryController?: (
    policy?: import("@eval-platform/eval-contracts").RetryPolicy,
  ) => RetryController;
  readonly idFactory?: () => string;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly onError?: (error: Error) => void;
}

/** Persists Run admissions only; Agent execution belongs to a separate resumer. */
export type EvalRunAdmission = Pick<EvalRuntime, "start" | "evaluate" | "pipeline">;

export type EvalRunAdmissionDependencies = Pick<
  EvalRuntimeDependencies,
  "sourceCommit" | "configResolver" | "store" | "idFactory"
> & { readonly catalog: RuntimeAdmissionCatalog };

/** Recovery reads persisted Run facts; admission APIs and Config resolution stay in the API process. */
export interface EvalRunResumerDependencies extends Omit<EvalRuntimeDependencies, "catalog" | "configResolver" | "sourceCommit"> {
  readonly getSamples: RuntimeCatalog["getSamples"];
  readonly getProject: RuntimeCatalog["getProject"];
}

export interface EvalRunResumer {
  resume(runId: string, stopSignal?: AbortSignal): Promise<void>;
  /** Interrupt active SP Submissions without finalizing still-running local tasks. */
  interrupt(runId: string): Promise<void>;
  /** Finalize a persisted stop request after local resume tasks have quiesced. */
  stop(runId: string): Promise<void>;
}
