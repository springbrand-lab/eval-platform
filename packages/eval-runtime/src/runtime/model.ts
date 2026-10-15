import type { Data, Dataset } from "@eval-platform/eval-dataset";
import type {
  AgentConfigRef,
  AgentRole,
  EvaluationOutputSchema,
  EvaluationRecord,
  EvaluateRequest,
  PipelineRequest,
  Project,
  RetryPolicy,
  RunHandle,
  RunSnapshot,
  Sampling,
  StartRunRequest,
} from "@eval-platform/eval-contracts";
import type { ConfigResolver } from "../config/model.js";
import type { Harness } from "../harness/model.js";
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

/** A detached copy of persisted Sampling facts returned by Runtime reads. */
export type SamplingSnapshot = Sampling;

export interface AgentOption {
  readonly agentConfig: AgentConfigRef;
  readonly name: string;
  readonly role: AgentRole;
}

export interface RuntimeCatalog {
  listProjects(): Promise<readonly Project[]>;
  getProject(projectId: string): Promise<Project | null>;
  /** Resolve the Project's selected output-format ID to its immutable Schema; null when none is selected. */
  getEvaluationOutputSchema(projectId: string): Promise<EvaluationOutputSchema | null>;
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

/** Persists Run admissions only; Agent execution belongs to a separate resumer. */
export interface EvalRunAdmission {
  start(request: StartRunRequest): Promise<RunHandle>;
  evaluate(request: EvaluateRequest): Promise<RunHandle>;
  pipeline(request: PipelineRequest): Promise<RunHandle>;
}

export interface EvalRunAdmissionDependencies {
  /** Resolved SP source commit of this Eval deployment; saved on newly admitted Runs. */
  readonly sourceCommit: string;
  readonly catalog: RuntimeAdmissionCatalog;
  readonly configResolver: ConfigResolver;
  readonly store: RuntimeStore;
  readonly idFactory?: () => string;
}

/** Detached, projected reads of persisted Run, Sampling and Evaluation facts. */
export interface EvalRunQueries {
  getRun(runId: string): Promise<RunSnapshot>;
  getSampling(samplingId: string): Promise<SamplingSnapshot>;
  getEvaluation(evaluationId: string): Promise<EvaluationRecord>;
  listEvaluations(samplingId: string): Promise<readonly EvaluationRecord[]>;
}

/** Recovery reads persisted Run facts; admission APIs and Config resolution stay in the API process. */
export interface EvalRunResumerDependencies {
  readonly getSamples: RuntimeCatalog["getSamples"];
  readonly getEvaluationOutputSchema: RuntimeCatalog["getEvaluationOutputSchema"];
  readonly harness: Harness;
  readonly store: RuntimeStore;
  readonly createRetryController?: (policy?: RetryPolicy) => RetryController;
  readonly idFactory?: () => string;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Receives failures that must not interrupt the Run; it should not throw. */
  readonly onError: (error: Error) => void;
}

export interface EvalRunResumer {
  resume(runId: string, stopSignal?: AbortSignal): Promise<void>;
  /** Interrupt active SP Submissions without finalizing still-running local tasks. */
  interrupt(runId: string): Promise<void>;
  /** Finalize a persisted stop request after local resume tasks have quiesced. */
  stop(runId: string): Promise<void>;
}
