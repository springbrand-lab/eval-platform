import type { Data } from "@eval-platform/eval-dataset";
import type {
  EvaluationOutputSchema,
  EvaluationRecord,
  ProjectPlan,
  RetryPolicy,
  RunHandle,
  RunOperation,
  RunRequest,
  RunSnapshot,
  RunTargetSelector,
  RunTargets,
  Sampling,
} from "@eval-platform/eval-contracts";
import type { Harness } from "../harness/model.js";
import type { RetryController } from "./retry.js";
import type { SamplingState, RuntimeStore } from "./store.js";

/**
 * One fixed test input of a Project: a full copy of its source Data taken at creation. Shared Data
 * bound by several Datasets is one ProjectSample. Later catalog edits never change it.
 */
export interface ProjectSample {
  readonly projectSampleId: string;
  readonly projectId: string;
  /** Source Data identity, kept for display and Dataset grouping only. */
  readonly dataId: string;
  /** Every bound Dataset containing this Data, in Project binding order. */
  readonly datasetIds: readonly string[];
  readonly samplingCount: number;
  readonly data: Data;
}

/**
 * Read-only view of Project plans. The API process injects an owner-scoped reader; the Worker injects
 * an all-owner reader. Runtime never reads live Dataset/Data or editable Agent Configs.
 */
export interface ProjectPlanReader {
  /** Null for an unknown or soft-deleted Project. */
  getProjectPlan(projectId: string): Promise<ProjectPlan | null>;
  /** One ProjectSample or null per input ID, in the same order. */
  getProjectSamples(projectId: string, projectSampleIds: readonly string[]): Promise<readonly (ProjectSample | null)[]>;
  /** Schema content referenced by `ProjectPlan.evaluation`; null when the Project has no evaluation plan. */
  getEvaluationOutputSchema(projectId: string): Promise<EvaluationOutputSchema | null>;
}

export interface RuntimeSamplingContext {
  readonly state: SamplingState;
  readonly sample: ProjectSample;
}

export interface RuntimeEvaluationContext {
  readonly sampling: SamplingState;
  readonly evaluation: EvaluationRecord;
  readonly sample: ProjectSample;
}

/** A detached copy of persisted Sampling facts returned by Runtime reads. */
export type SamplingSnapshot = Sampling;

export interface RunPreviewRequest {
  readonly projectId: string;
  readonly operation: RunOperation;
  readonly selector: RunTargetSelector;
}

/** Fixed targets the caller must submit unchanged; a retry reuses them instead of re-expanding. */
export interface RunPreview extends RunPreviewRequest {
  readonly targets: RunTargets;
  /** Samplings this Run would delete (execution/pipeline only). */
  readonly replacedSamplingCount: number;
  /** Samplings this Run would create (execution/pipeline only). */
  readonly newSamplingCount: number;
  /** EvaluationRecords this Run would create. */
  readonly evaluationCount: number;
  readonly executionPlanDigest: string;
  /** `ProjectEvaluation.digest`; null for execution. */
  readonly evaluationPlanDigest: string | null;
}

/** Persists Run admissions only; Agent execution belongs to a separate resumer. */
export interface EvalRunAdmission {
  preview(request: RunPreviewRequest): Promise<RunPreview>;
  submit(request: RunRequest): Promise<RunHandle>;
}

export interface EvalRunAdmissionDependencies {
  /** Resolved SP source commit of this Eval deployment; saved on newly admitted Runs. */
  readonly sourceCommit: string;
  readonly plans: ProjectPlanReader;
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

/** Recovery reads persisted Run facts and the Project plan; admission stays in the API process. */
export interface EvalRunResumerDependencies {
  readonly plans: ProjectPlanReader;
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
