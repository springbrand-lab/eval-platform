import type { HarnessConfig, JsonValue, Project, RetryPolicy } from "./model.js";

/**
 * Display-only copy of an Agent Config taken when it was frozen for a Project. Runs always use the
 * frozen copy's `AgentConfigRef`; they never rebuild configuration from this body.
 */
export interface AgentConfigSnapshot {
  /** The user's editable Agent Config the frozen copy was cloned from. */
  readonly sourceUserAgentId: string;
  readonly name: string;
  readonly body: Readonly<Record<string, JsonValue>>;
}

/** Fixed at Project creation and never edited. */
export interface ExecutionPlan {
  /** `agentConfig` is the Project's frozen copy, never the user's editable Agent Config. */
  readonly harness: HarnessConfig;
  readonly subjectAgentConfig: AgentConfigSnapshot;
  readonly executionConcurrency: number;
  readonly retryPolicy: RetryPolicy;
}

export interface EvaluationOutputSchemaRef {
  readonly outputSchemaId: string;
  /** sha256 of the canonical Schema JSON. */
  readonly digest: string;
}

/** Optional at creation; replaceable as a whole until the first evaluating Run locks it. */
export interface EvaluationPlan {
  /** `agentConfig` is the Project's frozen Evaluator copy. */
  readonly evaluationHarness: HarnessConfig & { readonly framework: "sp" };
  readonly evaluatorAgentConfig: AgentConfigSnapshot;
  readonly evaluationConcurrency: number;
  readonly retryPolicy: RetryPolicy;
  readonly outputSchema: EvaluationOutputSchemaRef;
}

/** A Dataset as bound at Project creation; later catalog edits do not change it. */
export interface ProjectDatasetSnapshot {
  readonly datasetId: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: "general" | "prompt";
  /** The bound ProjectSamples in the Dataset's member order at creation. */
  readonly projectSampleIds: readonly string[];
}

/** One consistent read of a Project's fixed plan. ProjectSamples are read separately in batches. */
export interface ProjectPlan {
  readonly project: Project;
  /** In the order the user bound them. */
  readonly datasets: readonly ProjectDatasetSnapshot[];
  readonly execution: ExecutionPlan;
  /** Computed by eval-runtime `digestExecutionPlan`. */
  readonly executionPlanDigest: string;
  /** Null until the user fills in the evaluation plan. */
  readonly evaluation: ProjectEvaluation | null;
}

/** The evaluation plan with its digest; they exist only together. */
export interface ProjectEvaluation {
  readonly plan: EvaluationPlan;
  readonly digest: string;
  /** Set in the admission transaction of the first pipeline/evaluation Run; never cleared. */
  readonly lockedAt: string | null;
}
