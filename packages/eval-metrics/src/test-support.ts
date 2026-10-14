import type {
  AgentResourceCollection,
  AgentResourceFact,
  AgentResourceSnapshot,
  EvaluationRecord,
} from "@eval-platform/eval-contracts";
import type { SamplingSnapshot } from "@eval-platform/eval-runtime";
import type { ResourceInput } from "./aggregation/model.js";

export const PROJECT = { projectId: "project-1", ownerUserId: "owner-1", name: "Product evaluation", sourceBranch: "release-2.0.0" };
export const SUBJECT = { ownerUserId: "owner-1", userAgentId: "subject-1" };
export const EVALUATOR = { ownerUserId: "owner-1", userAgentId: "judge-1" };
export const DATA = {
  dataId: "10000000-0000-4000-8000-000000000001", userPrompt: "Build a page", category: "frontend",
  initialSession: { bundleId: "session-bundle", sessionId: "seed-session" },
  initialMaterials: { bundleId: "material-bundle", materialId: "seed-files" },
};
export const SAMPLE = { sampleId: "sample-1", data: DATA };
export const DATASET = { datasetId: "20000000-0000-4000-8000-000000000001", name: "Web tasks" };

export function collection(patch: Partial<AgentResourceSnapshot> = {}): AgentResourceCollection {
  return {
    status: "collected",
    snapshot: {
      scope: { chatId: "subject-chat", submissionId: "subject-submission", idempotencyKey: "execution:sampling-1" },
      observedAt: "2026-10-08T00:00:01.000Z", finalized: true,
      coverage: { usageEvents: "complete", telemetryEvents: "complete", billingSettlements: "complete" },
      usageEvents: [], telemetryEvents: [], billingSettlements: [], ...patch,
    },
  };
}

export function resourceInput(patch: Partial<AgentResourceSnapshot> = {}, ownerUserId = "owner-1"): ResourceInput {
  return { ownerUserId, collection: collection(patch) };
}

export function usage(eventId: string, patch: AgentResourceFact = {}): AgentResourceFact {
  return {
    eventId, runId: "run-1", kind: "assistant_model", outcome: "billable",
    metrics: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 4 },
    providerMetadata: { provider: "provider-1", model: "model-1" }, providerCostUsd: { total: 0.5 }, ...patch,
  };
}

export function telemetry(
  eventId: string,
  type: string,
  operationId: string,
  payload: AgentResourceFact = {},
  occurredAt = 100,
  sessionId = "session-1",
): AgentResourceFact {
  return { eventId, type, operationId, occurredAt, resource: { sessionId }, payload };
}

export function settlement(eventId: string, patch: AgentResourceFact = {}): AgentResourceFact {
  return {
    eventId, accountId: "account-1", status: "settled", ratedUnits: 10,
    debitedUnits: 8, shortfallUnits: 2, platformOwned: { units: 2, reason: "insufficient_balance" }, ...patch,
  };
}

export function sampling(samplingId = "sampling-1", patch: Partial<SamplingSnapshot> = {}): SamplingSnapshot {
  return {
    samplingId, projectId: PROJECT.projectId, sampleId: SAMPLE.sampleId, subjectAgent: SUBJECT,
    subjectChatId: `subject:${samplingId}`, execution: { status: "succeeded" },
    executionAttempts: [{
      executionAttemptId: `attempt:${samplingId}`, samplingId, attemptNumber: 1,
      submissionId: `subject-submission:${samplingId}`, status: "completed",
      startedAt: "2026-10-08T00:00:00.000Z", completedAt: "2026-10-08T00:00:01.000Z",
      resources: collection({ scope: {
        chatId: `subject:${samplingId}`, submissionId: `subject-submission:${samplingId}`,
        idempotencyKey: `execution:${samplingId}`,
      } }),
    }],
    artifacts: [{ artifactId: `artifact:${samplingId}`, kind: "file", path: "/workspace/page.html" }],
    trajectory: { trajectoryId: `trajectory:${samplingId}`, source: "subject", path: "/trajectory.json" }, ...patch,
  };
}

export function evaluation(evaluationId = "evaluation-1", patch: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    evaluationId, samplingId: "sampling-1", evaluator: EVALUATOR, chatId: `judge:${evaluationId}`,
    status: { status: "succeeded" },
    attempts: [{
      evaluationAttemptId: `attempt:${evaluationId}`, evaluationId, attemptNumber: 1,
      submissionId: `judge-submission:${evaluationId}`, status: "completed",
      startedAt: "2026-10-08T00:00:02.000Z", completedAt: "2026-10-08T00:00:04.000Z",
      resources: collection({ scope: {
        chatId: `judge:${evaluationId}`, submissionId: `judge-submission:${evaluationId}`,
        idempotencyKey: "evaluation:sampling-1",
      } }),
    }],
    output: {
      status: "succeeded", score: 80, reason: "The produced page meets the task.",
      artifacts: [{ artifactId: `report:${evaluationId}`, kind: "report", path: "/evaluation.json" }],
      evidenceRefs: [{ kind: "artifact", ref: "/workspace/page.html" }],
      trajectory: { trajectoryId: `trajectory:${evaluationId}`, source: "evaluator", path: "/judge-trajectory.json" },
    }, ...patch,
  };
}
