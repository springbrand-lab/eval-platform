import type {
  AgentConfigSnapshot,
  EvaluationOutputSchema,
  EvaluationPlan,
  ExecutionPlan,
  HarnessConfig,
  ProjectDatasetSnapshot,
  ProjectPlan,
  RetryPolicy,
  RunOperation,
  RunPhases,
} from "@eval-platform/eval-contracts";
import { AGENT_FRAMEWORKS, jsonObjectSchema } from "@eval-platform/eval-contracts";
import { canonicalJsonBytes, sha256Hex } from "@springbrand/utils";
import { RuntimeInputError } from "../runtime/errors.js";
import { requireIdentifier } from "../runtime/input.js";
import type { ProjectSample } from "../runtime/model.js";
import { DEFAULT_RETRY_POLICY, requireRetryPolicy } from "../runtime/retry.js";

export { DEFAULT_RETRY_POLICY };

/** Caller input; `retryPolicy` defaults to DEFAULT_RETRY_POLICY. */
export type ExecutionPlanInput = Omit<ExecutionPlan, "retryPolicy"> & { readonly retryPolicy?: RetryPolicy };
export type EvaluationPlanInput = Omit<EvaluationPlan, "retryPolicy"> & { readonly retryPolicy?: RetryPolicy };

/** Every ProjectSample of the plan once, in Dataset binding order then member order. */
export function planProjectSampleIds(plan: ProjectPlan): readonly string[] {
  return [...new Set(plan.datasets.flatMap(({ projectSampleIds }) => projectSampleIds))];
}

export function phasesOf(operation: RunOperation): RunPhases {
  switch (operation) {
    case "execution": return ["execution"];
    case "evaluation": return ["evaluation"];
    case "pipeline": return ["execution", "evaluation"];
  }
}

/** The single validation and normalization boundary for an execution plan. */
export function normalizeExecutionPlan(input: ExecutionPlanInput): ExecutionPlan {
  requireObject(input, "execution");
  requirePositiveInteger(input.executionConcurrency, "execution.executionConcurrency");
  if (input.retryPolicy !== undefined) requireRetryPolicy(input.retryPolicy);
  return {
    harness: normalizeHarness(input.harness, "execution.harness"),
    subjectAgentConfig: normalizeAgentConfigSnapshot(input.subjectAgentConfig, "execution.subjectAgentConfig"),
    executionConcurrency: input.executionConcurrency,
    retryPolicy: { ...(input.retryPolicy ?? DEFAULT_RETRY_POLICY) },
  };
}

/** The single validation and normalization boundary for an evaluation plan; Evaluators use SP. */
export function normalizeEvaluationPlan(input: EvaluationPlanInput): EvaluationPlan {
  requireObject(input, "evaluation");
  requirePositiveInteger(input.evaluationConcurrency, "evaluation.evaluationConcurrency");
  if (input.retryPolicy !== undefined) requireRetryPolicy(input.retryPolicy);
  const harness = normalizeHarness(input.evaluationHarness, "evaluation.evaluationHarness");
  if (harness.framework !== "sp") {
    throw new RuntimeInputError("evaluationHarness must use the SP framework", "evaluation.evaluationHarness.framework");
  }
  requireObject(input.outputSchema, "evaluation.outputSchema");
  requireIdentifier(input.outputSchema.outputSchemaId, "evaluation.outputSchema.outputSchemaId");
  requireIdentifier(input.outputSchema.digest, "evaluation.outputSchema.digest");
  return {
    evaluationHarness: { ...harness, framework: "sp" },
    evaluatorAgentConfig: normalizeAgentConfigSnapshot(input.evaluatorAgentConfig, "evaluation.evaluatorAgentConfig"),
    evaluationConcurrency: input.evaluationConcurrency,
    retryPolicy: { ...(input.retryPolicy ?? DEFAULT_RETRY_POLICY) },
    outputSchema: { outputSchemaId: input.outputSchema.outputSchemaId, digest: input.outputSchema.digest },
  };
}

/** Covers the execution plan, Dataset bindings and every ProjectSample snapshot. */
export function digestExecutionPlan(input: {
  readonly execution: ExecutionPlan;
  readonly datasets: readonly ProjectDatasetSnapshot[];
  readonly samples: readonly ProjectSample[];
}): Promise<string> {
  const samples = input.samples
    .map(({ projectSampleId, dataId, datasetIds, samplingCount, data }) => ({
      projectSampleId, dataId, datasetIds, samplingCount, data,
    }))
    .sort((left, right) => left.projectSampleId < right.projectSampleId ? -1 : left.projectSampleId > right.projectSampleId ? 1 : 0);
  return digestJson({ execution: input.execution, datasets: input.datasets, samples });
}

/** sha256 of canonical JSON: the single digest used for plans, Schemas and request fingerprints. */
export function digestJson(value: unknown): Promise<string> {
  return sha256Hex(canonicalJsonBytes(value));
}

export function digestEvaluationPlan(evaluation: EvaluationPlan): Promise<string> {
  return digestJson(evaluation);
}

/** The digest stored in EvaluationOutputSchemaRef. */
export function digestEvaluationOutputSchema(schema: EvaluationOutputSchema): Promise<string> {
  return digestJson(schema);
}

function normalizeHarness(harness: HarnessConfig, field: string): HarnessConfig {
  requireObject(harness, field);
  if (harness.kind !== "sp") throw new RuntimeInputError(`${field}.kind must be sp`, `${field}.kind`);
  if (!(AGENT_FRAMEWORKS as readonly unknown[]).includes(harness.framework)) {
    throw new RuntimeInputError(`${field}.framework must be one of ${AGENT_FRAMEWORKS.join(", ")}`, `${field}.framework`);
  }
  requireObject(harness.agentConfig, `${field}.agentConfig`);
  requireIdentifier(harness.agentConfig.ownerUserId, `${field}.agentConfig.ownerUserId`);
  requireIdentifier(harness.agentConfig.userAgentId, `${field}.agentConfig.userAgentId`);
  if (harness.runtime !== undefined) requireObject(harness.runtime, `${field}.runtime`);
  const timeoutMs = harness.runtime?.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 1)) {
    throw new RuntimeInputError(`${field}.runtime.timeoutMs must be a positive number`, `${field}.runtime.timeoutMs`);
  }
  return {
    kind: "sp",
    framework: harness.framework,
    agentConfig: { ownerUserId: harness.agentConfig.ownerUserId, userAgentId: harness.agentConfig.userAgentId },
    ...(harness.runtime === undefined ? {} : { runtime: { ...(timeoutMs === undefined ? {} : { timeoutMs }) } }),
  };
}

function normalizeAgentConfigSnapshot(snapshot: AgentConfigSnapshot, field: string): AgentConfigSnapshot {
  requireObject(snapshot, field);
  requireIdentifier(snapshot.sourceUserAgentId, `${field}.sourceUserAgentId`);
  if (typeof snapshot.name !== "string") throw new RuntimeInputError(`${field}.name must be a string`, `${field}.name`);
  const body = jsonObjectSchema.safeParse(snapshot.body);
  if (!body.success) throw new RuntimeInputError(`${field}.body must be a JSON object`, `${field}.body`);
  return { sourceUserAgentId: snapshot.sourceUserAgentId, name: snapshot.name, body: body.data };
}

function requireObject(value: unknown, field: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeInputError(`${field} must be an object`, field);
  }
}

function requirePositiveInteger(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RuntimeInputError(`${field} must be a positive integer`, field);
  }
}
