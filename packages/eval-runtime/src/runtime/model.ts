import type { Data } from "@eval-platform/eval-dataset";
import type {
  EvaluationOutputSchema,
  EvaluationRecord,
  EvidenceLimits,
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
import type { EvidenceStore, Harness } from "../harness/model.js";
import type { RuntimeContext, RuntimeLog } from "./log.js";
import type { RetryController } from "./retry.js";
import type { EvaluationState, SamplingState, RuntimeStore } from "./store.js";
import type { EvaluationScorePort } from "./scores.js";
import type { EvaluationResultPort } from "./results.js";

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

/** The active Run identity and stop intent, projected from the public Run facts. */
export type CurrentRun = Pick<RunSnapshot, "runId" | "stopRequested">;

/** Latest admission sequence plus the active Run, derived by the host from its Run records. */
export interface ProjectRunState {
  readonly runSequence: number;
  readonly currentRun: CurrentRun | null;
}

/** Shared read projection consumed by the API and Web, independent of persistence and HTTP. */
export interface ProjectView extends ProjectPlan, ProjectRunState {
  readonly projectSamples: readonly ProjectSample[];
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
  readonly evaluation: EvaluationState;
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
  /** Match only an already-persisted Project/key Run against its original complete intent.
   * Null means no stored Run; this never previews or admits new targets. */
  replay(request: RunRequest): Promise<RunHandle | null>;
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
  /** Freezes each succeeded Subject's evidence; every Evaluation reads only from it. */
  readonly evidence: EvidenceStore;
  readonly evidenceLimits?: EvidenceLimits;
  readonly createRetryController?: (policy?: RetryPolicy) => RetryController;
  readonly idFactory?: () => string;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Optional score integration. Metrics interprets the raw output; Runtime only delivers scores. */
  readonly scores?: EvaluationScorePort;
  /** Result submission and Schema checking; only a valid result makes an Evaluation succeed. */
  readonly results?: EvaluationResultPort;
  /** Receives failures that must not interrupt the Run, with the members they belong to; it should not throw. */
  readonly onError: (error: Error, context?: RuntimeContext) => void;
  /** Structured diagnostics such as `run_pass_summary`, `stage_attempt` and `resources_collected`; see the README. */
  readonly log?: RuntimeLog;
}

/** Why a stop forced a stage terminal: nothing was dispatched, the Agent was stopped, or its results were still pending. */
export type StageStopReason = "not-started" | "agent-stopped" | "status-unconfirmed" | "evidence-export" | "output-collection";

export interface StoppedStageReport {
  readonly stage: "execution" | "evaluation";
  readonly samplingId: string;
  readonly evaluationId?: string;
  readonly status: "failed" | "cancelled";
  readonly reason: StageStopReason;
}

/** Identities and counts of one stop finalization, never payloads; it should not throw. */
export interface RunStopReporter {
  /** Run members by `<stage>.<status>[.<pending flag>]` before finalization. */
  finalizing(states: Readonly<Record<string, number>>): void;
  stageStopped(report: StoppedStageReport): void;
}

export interface EvalRunResumer {
  /** Runs a Run's due work; a Run whose stop is pending is left to `stop`. */
  resume(runId: string, stopSignal?: AbortSignal): Promise<void>;
  /** Interrupt active SP Submissions without finalizing still-running local tasks. */
  interrupt(runId: string): Promise<void>;
  /**
   * Finalize a pending stop after local resume tasks have quiesced: every pending stage ends without
   * re-running an Agent, exporting evidence or reading resources; owed resources are recorded as failed.
   */
  stop(runId: string, reporter?: RunStopReporter): Promise<void>;
}
