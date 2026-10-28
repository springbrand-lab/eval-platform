import {
  AGENT_STATUSES, EVIDENCE_KINDS, jsonObjectArrayInPlaceSchema,
  isSpPiTrajectoryReference, spPiTrajectoryIdentityParts, spPiTrajectoryPageRowSchema, spPiTrajectoryPageSchema,
} from "@eval-platform/eval-contracts";
import type {
  AgentResourceReadiness,
  AgentResourceReadinessReport,
  AgentResourceSnapshot,
  EvaluationAgentOutput,
  EvaluationStructuredOutput,
  ExecutionOutput,
  JsonValue,
  MaterializedDataBinding,
  PiTrajectoryRecord,
  SpPiTrajectoryPage,
  SpPiTrajectoryPageRow,
} from "@eval-platform/eval-contracts";
import type { AgentHandle, AgentSubmission, EnsureAgentInput } from "@eval-platform/eval-runtime/harness";
import {
  evalEnsureChatSchema,
  evalInitializationResultSchema,
  evalEvidenceArtifactsSchema,
  evalInitializationSchema,
  evalSubmitSchema,
  stableEvalFacts,
  type EvalEnsureChat,
  type EvalEvidenceArtifact,
  type EvalEvidenceFileReceipt,
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
const count = z.number().int().nonnegative().safe();

const scopeSchema = z.object({ chatId: id, idempotencyKey: id, submissionId: id });

const readinessSchema = z.object({
  receiptTerminal: z.boolean(),
  stateUnreadable: z.boolean(),
  pendingTelemetryEvents: count,
  pendingRuntimeEvents: count,
  actionCharges: z.object({ complete: z.boolean(), unsettledExecutions: count, missingExecutionIds: count }),
}) satisfies z.ZodType<AgentResourceReadiness>;

/** Raw SP HTTP wire only. Every reference is hydrated before leaving the Harness for Runtime/Metrics. */
export type SpResourceSnapshotWire = Omit<AgentResourceSnapshot, "nativeRecords"> & {
  readonly nativeRecords: readonly SpPiTrajectoryPageRow[];
};

const resourceSnapshotSchema = z.strictObject({
  scope: scopeSchema,
  observedAt: id,
  finalized: z.boolean(),
  coverage: z.strictObject({
    usageEvents: completenessSchema,
    nativeRecords: completenessSchema,
    billingSettlements: completenessSchema,
  }),
  usageEvents: jsonObjectArrayInPlaceSchema,
  nativeRecords: z.array(spPiTrajectoryPageRowSchema),
  billingSettlements: jsonObjectArrayInPlaceSchema,
  readiness: readinessSchema,
}).superRefine((snapshot, context) => {
  snapshot.nativeRecords.forEach((row, index) => {
    const { ingestSeq } = row;
    if (index > 0 && ingestSeq <= snapshot.nativeRecords[index - 1]!.ingestSeq) {
      context.addIssue({ code: "custom", path: ["nativeRecords", index, "ingestSeq"],
        message: "Native records must ascend" });
    }
    const sessionId = isSpPiTrajectoryReference(row)
      ? spPiTrajectoryIdentityParts(row.reference.identity)?.[1]
      : row.record.resource.sessionId;
    if (sessionId !== snapshot.scope.chatId) {
      context.addIssue({ code: "custom", path: ["nativeRecords", index, "record", "resource", "sessionId"],
        message: "Native record belongs to another Chat" });
    }
  });
}) satisfies z.ZodType<SpResourceSnapshotWire>;

export function resourceSnapshot(value: unknown): SpResourceSnapshotWire {
  return response(resourceSnapshotSchema, value, "resource snapshot");
}

export function resourceReadiness(value: unknown): AgentResourceReadinessReport {
  return response(z.object({
    scope: scopeSchema,
    observedAt: id,
    finalized: z.boolean(),
    readiness: readinessSchema,
  }) satisfies z.ZodType<AgentResourceReadinessReport>, value, "resource readiness");
}

export function evidenceArtifacts(value: unknown): readonly EvalEvidenceArtifact[] {
  return response(evalEvidenceArtifactsSchema, value, "evidence artifact list").artifacts;
}

export function evidenceTrajectoryPage(value: unknown): SpPiTrajectoryPage {
  // Replace the structural consumer schema with @springbrand/eval-harness's published
  // public schema after SP's Pi-native package release; never import its private source.
  return response(spPiTrajectoryPageSchema, value, "evidence trajectory page");
}

/** Only model[0] of a native Entry can carry the selected Submission's assistant
 * reply. `undefined` is not an assistant; `null` is an assistant with no usable
 * complete reply (so an earlier message must not be substituted). */
export function finalReplyText(value: PiTrajectoryRecord, submissionId: string): string | null | undefined {
  if (value.format !== "pi-trajectory/v1" || value.projection?.kind !== "safe"
    || value.submissionId !== submissionId || value.origin === "context"
    || value.record.type !== "entry") return undefined;
  const entry = value.record.value;
  if (entry.kind === "springbrand.trajectory") return undefined;
  const models = entry.model;
  if (!Array.isArray(models) || models.length !== 1) {
    return entry.kind === "pi.assistant" || (Array.isArray(models) && models.some((item) =>
      item !== null && typeof item === "object" && !Array.isArray(item) && item.role === "assistant"))
      ? null : undefined;
  }
  const item = models[0];
  if (item === null || typeof item !== "object" || Array.isArray(item)) return entry.kind === "pi.assistant" ? null : undefined;
  const message = item as Record<string, JsonValue>;
  if (message.role !== "assistant") return entry.kind === "pi.assistant" ? null : undefined;
  if (!Array.isArray(message.content)
    || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)
    || message.stopReason !== "stop") return null;
  const blocks: string[] = [];
  for (const block of message.content) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) return null;
    const content = block as Record<string, JsonValue>;
    if (content.type === "thinking") continue;
    if (content.type !== "text" || typeof content.text !== "string"
      || content.text === "[REDACTED]" || content.text === "[CONTENT OMITTED]") return null;
    blocks.push(content.text);
  }
  const text = blocks.join("\n");
  return text.trim() === "" ? null : text;
}

export function evidenceFileReceipt(value: unknown): EvalEvidenceFileReceipt {
  return response(z.object({
    path: id,
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }), value, "evidence file receipt");
}
