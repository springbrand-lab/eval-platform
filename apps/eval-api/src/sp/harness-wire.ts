import { AGENT_STATUSES, EVIDENCE_KINDS, jsonObjectArrayInPlaceSchema } from "@eval-platform/eval-contracts";
import type {
  AgentResourceReadinessReport,
  AgentResourceSnapshot,
  EvaluationAgentOutput,
  EvaluationStructuredOutput,
  ExecutionOutput,
  MaterializedDataBinding,
} from "@eval-platform/eval-contracts";
import {
  PI_TRAJECTORY_FORMAT, nativeResourceReadinessSchema, validateNativeResourceScope,
  type AgentHandle, type AgentSubmission, type EnsureAgentInput,
} from "@eval-platform/eval-runtime/harness";
import {
  evalEnsureChatSchema,
  evalInitializationResultSchema,
  evalEvidenceArtifactsSchema,
  evalEvidenceTrajectoryPageSchema,
  evalInitializationSchema,
  evalSubmitSchema,
  evalTrajectoryScopeSchema,
  evalTrajectoryCursorSchema,
  evalSafeTrajectoryRecordSchema,
  EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX,
  stableEvalFacts,
  type EvalEnsureChat,
  type EvalEvidenceArtifact,
  type EvalEvidenceFileReceipt,
  type EvalEvidenceTrajectoryPage,
  type EvalInitialization,
  type EvalInitializationResult,
  type EvalSubmissionReceipt,
  type EvalSubmit,
} from "@springbrand/eval-harness";
import { z } from "zod";
import { SpHarnessError } from "./harness-error.js";

/** Validate an outgoing request with SP's own contract so a rejection never costs a round trip. */
function request<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new SpHarnessError(`Eval SP ${name} request is invalid`, false, { cause });
  }
}

function response<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SpHarnessError(`Eval SP returned an invalid ${name}`, false, { cause: parsed.error });
  return parsed.data;
}

export function ensureChatRequest(input: EnsureAgentInput): EvalEnsureChat {
  return request<EvalEnsureChat>(evalEnsureChatSchema, {
    chatId: input.chatId,
    role: input.role,
    framework: input.framework,
    samplingId: input.samplingId,
    projectId: input.projectId,
    agentConfig: { ownerUserId: input.agentConfig.ownerUserId, userAgentId: input.agentConfig.userAgentId },
    ...(input.evaluationId === undefined ? {} : { evaluationId: input.evaluationId }),
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  }, "Chat");
}

export function initializationRequest(input: EvalInitialization): EvalInitialization {
  return request<EvalInitialization>(evalInitializationSchema, input, "initialization");
}

export function submitRequest(input: EvalSubmit): EvalSubmit {
  return request<EvalSubmit>(evalSubmitSchema, input, "Submission");
}

/** SP echoes the immutable creation facts; any difference means the Chat belongs to someone else. */
export function agentHandle(value: unknown, chat: EvalEnsureChat): AgentHandle {
  const handle: AgentHandle = {
    role: chat.role,
    framework: chat.framework,
    ownerUserId: chat.agentConfig.ownerUserId,
    chatId: chat.chatId,
    samplingId: chat.samplingId,
    ...(chat.evaluationId === undefined ? {} : { evaluationId: chat.evaluationId }),
  };
  if (stableEvalFacts(value) !== stableEvalFacts(handle)) {
    throw new SpHarnessError("Eval SP returned an Agent handle with different creation facts", false);
  }
  return handle;
}

const id = z.string().min(1);

const receiptSchema = z.object({
  submissionId: id,
  status: z.string(),
  normalizedStatus: z.enum(AGENT_STATUSES),
  accepted: z.boolean(),
  error: z.string().exactOptional(),
  retryable: z.boolean().exactOptional(),
  createdAt: z.number(),
  completedAt: z.number().exactOptional(),
}) satisfies z.ZodType<EvalSubmissionReceipt>;

/** Maps the SP receipt once: the domain status is SP's normalized status, never its raw status. */
export function submission(value: unknown): AgentSubmission {
  const { status: _rawStatus, normalizedStatus, ...receipt } = response(receiptSchema, value, "Submission receipt");
  return { ...receipt, status: normalizedStatus };
}

export function requireStopResult(value: unknown): void {
  response(z.object({ ok: z.boolean() }), value, "stop result");
}

export function dataBinding(value: unknown): MaterializedDataBinding {
  return response<EvalInitializationResult>(evalInitializationResultSchema, value, "initialization binding");
}

const artifactsSchema = z.array(z.looseObject({
  artifactId: id,
  kind: id,
  path: id,
  contentHash: id.exactOptional(),
}));

function trajectorySchema<Source extends "subject" | "evaluator">(source: Source) {
  return z.looseObject({
    trajectoryId: id, source: z.literal(source), path: id, contentHash: id.exactOptional(),
    format: z.literal(PI_TRAJECTORY_FORMAT), scope: evalTrajectoryScopeSchema, cursor: evalTrajectoryCursorSchema,
  });
}

const outputStatusSchema = z.enum(["succeeded", "failed"]);

export function executionOutput(value: unknown, samplingId: string): ExecutionOutput {
  return response(z.looseObject({
    samplingId: z.literal(samplingId),
    status: outputStatusSchema,
    artifacts: artifactsSchema,
    trajectory: trajectorySchema("subject"),
    error: z.string().exactOptional(),
  }), value, "execution output");
}

const structuredOutputSchema = z.object({
  path: id,
  content: z.string(),
  contentHash: id.exactOptional(),
}) satisfies z.ZodType<EvaluationStructuredOutput>;

/** Keeps the Evaluator's raw result file unchanged; top-level fields outside the contract are dropped. */
export function evaluationOutput(value: unknown): EvaluationAgentOutput {
  return response(z.object({
    status: outputStatusSchema,
    artifacts: artifactsSchema,
    structuredOutput: structuredOutputSchema.exactOptional(),
    evidenceRefs: z.array(z.object({
      kind: z.enum(EVIDENCE_KINDS),
      ref: id,
      contentHash: id.exactOptional(),
    })).exactOptional(),
    trajectory: trajectorySchema("evaluator"),
    error: z.string().exactOptional(),
  }), value, "evaluation output");
}

const completenessSchema = z.enum(["complete", "partial", "unavailable"]);
const scopeSchema = z.object({ chatId: id, idempotencyKey: id, submissionId: id });

const resourceSnapshotSchema = z.object({
  scope: scopeSchema,
  observedAt: id,
  finalized: z.boolean(),
  trajectoryFormat: z.literal(PI_TRAJECTORY_FORMAT),
  coverage: z.object({
    usageEvents: completenessSchema,
    telemetryEvents: completenessSchema,
    billingSettlements: completenessSchema,
  }),
  usageEvents: jsonObjectArrayInPlaceSchema,
  telemetryEvents: jsonObjectArrayInPlaceSchema,
  billingSettlements: jsonObjectArrayInPlaceSchema,
  readiness: nativeResourceReadinessSchema,
}) satisfies z.ZodType<AgentResourceSnapshot>;

export function resourceSnapshot(value: unknown): AgentResourceSnapshot {
  const snapshot = response(resourceSnapshotSchema, value, "resource snapshot");
  try {
    validateNativeResourceScope(snapshot, true);
    for (const event of snapshot.telemetryEvents) evalSafeTrajectoryRecordSchema.parse(event);
  } catch (cause) {
    throw new SpHarnessError("Eval SP returned an invalid native resource trajectory", false, { cause });
  }
  return value as AgentResourceSnapshot;
}

export function resourceReadiness(value: unknown): AgentResourceReadinessReport {
  const report = response(z.strictObject({
    scope: scopeSchema,
    observedAt: id,
    finalized: z.boolean(),
    readiness: nativeResourceReadinessSchema,
  }) satisfies z.ZodType<AgentResourceReadinessReport>, value, "resource readiness");
  try {
    validateNativeResourceScope(report, false);
  } catch (cause) {
    throw new SpHarnessError("Eval SP returned inconsistent native resource readiness", false, { cause });
  }
  return value as AgentResourceReadinessReport;
}

export function evidenceArtifacts(value: unknown): readonly EvalEvidenceArtifact[] {
  return response(evalEvidenceArtifactsSchema, value, "evidence artifact list").artifacts;
}

export function evidenceTrajectoryPage(value: unknown) {
  response(evalEvidenceTrajectoryPageSchema, value, "evidence trajectory page");
  const page = value as EvalEvidenceTrajectoryPage;
  if (page.events.length > EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX) {
    throw new SpHarnessError("Eval SP returned an oversized evidence trajectory page", false);
  }
  return page;
}

export function evidenceFileReceipt(value: unknown): EvalEvidenceFileReceipt {
  return response(z.object({
    path: id,
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }), value, "evidence file receipt");
}
