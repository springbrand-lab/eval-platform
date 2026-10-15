import { AGENT_STATUSES } from "@eval-platform/eval-contracts";
import type {
  AgentResourceSnapshot,
  EvaluationAgentOutput,
  ExecutionOutput,
  MaterializedDataBinding,
} from "@eval-platform/eval-contracts";
import type { AgentHandle, AgentSubmission, EnsureAgentInput } from "@eval-platform/eval-runtime/harness";
import {
  evalEnsureChatSchema,
  evalInitializationSchema,
  evalSubmitSchema,
  evalTrajectoryMaterializationSchema,
  stableEvalFacts,
  type EvalEnsureChat,
  type EvalInitialization,
  type EvalSubmissionReceipt,
  type EvalSubmit,
  type EvalTrajectoryMaterialization,
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
    ...(input.evaluationWorkspace === undefined ? {} : { evaluationWorkspace: input.evaluationWorkspace }),
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  }, "Chat");
}

export function initializationRequest(input: EvalInitialization): EvalInitialization {
  return request<EvalInitialization>(evalInitializationSchema, input, "initialization");
}

export function submitRequest(input: EvalSubmit): EvalSubmit {
  return request<EvalSubmit>(evalSubmitSchema, input, "Submission");
}

export function trajectoryRequest(input: EvalTrajectoryMaterialization): EvalTrajectoryMaterialization {
  return request<EvalTrajectoryMaterialization>(evalTrajectoryMaterializationSchema, input, "trajectory");
}

/** SP echoes the immutable creation facts; any difference means the Chat belongs to someone else. */
export function agentHandle(value: unknown, chat: EvalEnsureChat): AgentHandle {
  const handle: AgentHandle = {
    role: chat.role,
    framework: chat.framework,
    ownerUserId: chat.agentConfig.ownerUserId,
    chatId: chat.chatId,
    samplingId: chat.samplingId,
    ...(chat.evaluationWorkspace === undefined ? {} : { evaluationWorkspace: chat.evaluationWorkspace }),
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

const dataBindingSchema = z.object({
  bundleId: id,
  manifestHash: id,
  target: z.enum(["workspace", "sandbox"]),
  rootPath: id,
}) satisfies z.ZodType<MaterializedDataBinding>;

export function dataBinding(value: unknown): MaterializedDataBinding {
  return response(dataBindingSchema, value, "initialization binding");
}

const artifactsSchema = z.array(z.looseObject({
  artifactId: id,
  kind: id,
  path: id,
  contentHash: id.exactOptional(),
}));

function trajectorySchema<Source extends "subject" | "evaluator">(source: Source) {
  return z.looseObject({ trajectoryId: id, source: z.literal(source), path: id, contentHash: id.exactOptional() });
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

export function evaluationOutput(value: unknown): EvaluationAgentOutput {
  return response(z.looseObject({
    status: outputStatusSchema,
    artifacts: artifactsSchema,
    trajectory: trajectorySchema("evaluator"),
    error: z.string().exactOptional(),
  }), value, "evaluation output");
}

const completenessSchema = z.enum(["complete", "partial", "unavailable"]);
const factsSchema = z.array(z.record(z.string(), z.json()));

const resourceSnapshotSchema = z.object({
  scope: z.object({ chatId: id, idempotencyKey: id, submissionId: id }),
  observedAt: id,
  finalized: z.boolean(),
  coverage: z.object({
    usageEvents: completenessSchema,
    telemetryEvents: completenessSchema,
    billingSettlements: completenessSchema,
  }),
  usageEvents: factsSchema,
  telemetryEvents: factsSchema,
  billingSettlements: factsSchema,
}) satisfies z.ZodType<AgentResourceSnapshot>;

export function resourceSnapshot(value: unknown): AgentResourceSnapshot {
  return response(resourceSnapshotSchema, value, "resource snapshot");
}
