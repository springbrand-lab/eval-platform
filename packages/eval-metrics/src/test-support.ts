import { readFileSync } from "node:fs";
import {
  summarizeResourceSnapshot,
  type AgentResourceCollection,
  type AgentResourceFact,
  type AgentResourceScope,
  type AgentResourceSnapshot,
  type EvaluationOutputSchema,
  type JsonValue,
  type NativeTrajectoryEntry,
  type ProjectDatasetSnapshot,
  type ProjectPlan,
  type RunSnapshot,
  nativeTrajectoryEntrySchema,
} from "@eval-platform/eval-contracts";
import type { ProjectSample } from "@eval-platform/eval-runtime";
import type { MetricsEvaluation, MetricsSampling } from "./aggregation/model.js";
import type { ResourceInput } from "./aggregation/resources.js";
import type { MetricsFacts } from "./reporting/model.js";

export const PROJECT = {
  projectId: "project-1", ownerUserId: "owner-1", name: "Product evaluation",
  sourceBranch: "release-2.0.0", createdAt: "2026-10-01T00:00:00.000Z",
};
const SUBJECT = { ownerUserId: "owner-1", userAgentId: "subject-1" };
const EVALUATOR = { ownerUserId: "owner-1", userAgentId: "judge-1" };
const DATA = {
  dataId: "10000000-0000-4000-8000-000000000001", userPrompt: "Build a page",
  evalPrompt: "Judge the finished page", category: "frontend",
};
export const SCHEMA_REF = { outputSchemaId: "30000000-0000-4000-8000-000000000001", digest: "a".repeat(64) };
export const OUTPUT_SCHEMA: EvaluationOutputSchema = {
  type: "object",
  required: ["score"],
  properties: {
    score: { type: "number" },
    summary: { type: "string" },
    scores: { type: "array", items: { $ref: "#/$defs/criterion" } },
  },
  $defs: { criterion: { type: "object", properties: { name: { type: "string" }, value: { type: "integer" } }, required: ["value"] } },
};

export function projectSample(projectSampleId: string, datasetIds: readonly string[], dataId = DATA.dataId, samplingCount = 1): ProjectSample {
  return { projectSampleId, projectId: PROJECT.projectId, dataId, datasetIds, samplingCount, data: { ...DATA, dataId } };
}

export function dataset(datasetId: string, projectSampleIds: readonly string[]): ProjectDatasetSnapshot {
  return { datasetId, name: `Dataset ${datasetId}`, kind: "general", projectSampleIds };
}

export function plan(datasets: readonly ProjectDatasetSnapshot[], evaluation = true): ProjectPlan {
  const retryPolicy = { maxRestarts: 1, initialBackoffMs: 250, maxBackoffMs: 10_000 };
  const snapshot = (sourceUserAgentId: string) => ({ sourceUserAgentId, name: sourceUserAgentId, body: {} });
  return {
    project: PROJECT, datasets,
    execution: {
      harness: { kind: "sp", framework: "sp", agentConfig: SUBJECT }, subjectAgentConfig: snapshot("subject-source"),
      executionConcurrency: 2, retryPolicy,
    },
    executionPlanDigest: "b".repeat(64),
    evaluation: evaluation
      ? {
        plan: {
          evaluationHarness: { kind: "sp", framework: "sp", agentConfig: EVALUATOR }, evaluatorAgentConfig: snapshot("judge-source"),
          evaluationConcurrency: 2, retryPolicy, outputSchema: SCHEMA_REF,
        },
        digest: "c".repeat(64), lockedAt: "2026-10-02T00:00:00.000Z",
      }
      : null,
  };
}

export function run(runId: string, patch: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId, projectId: PROJECT.projectId, sourceCommit: "d".repeat(40), operation: "pipeline",
    phases: ["execution", "evaluation"], phase: "evaluation", status: "succeeded",
    selector: { all: true }, targets: { projectSampleIds: [], samplingIds: [] },
    samplingIds: [], evaluationIds: [], ...patch,
  };
}

export function facts(patch: Partial<MetricsFacts> & Pick<MetricsFacts, "plan" | "projectSamples">): MetricsFacts {
  return {
    evaluationOutputSchema: patch.plan.evaluation ? OUTPUT_SCHEMA : null,
    samplings: [], evaluations: [], runs: [], ...patch,
  };
}

export function collection(patch: Partial<AgentResourceSnapshot> = {}): AgentResourceCollection {
  const snapshot: AgentResourceSnapshot = {
    scope: { chatId: "subject-chat", submissionId: "subject-submission", idempotencyKey: "execution:sampling-1" },
    observedAt: "2026-10-08T00:00:01.000Z", finalized: true,
    coverage: { usageEvents: "complete", nativeRecords: "complete", billingSettlements: "complete" },
    usageEvents: [], nativeRecords: [], billingSettlements: [], ...patch,
  };
  return { status: "collected", summary: summarizeResourceSnapshot(snapshot), snapshot };
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

/** Exactly the safe output of the published public UA generator, verified by
 * `scripts/generate-pi-native-fixture.mjs`. No event-only "native" constructors. */
const publicFixture = JSON.parse(readFileSync(new URL("../../../fixtures/pi-native-public-v1.json", import.meta.url), "utf8")) as {
  readonly records: readonly NativeTrajectoryEntry[];
};
export function nativeFixture(...ingestSeqs: readonly number[]): NativeTrajectoryEntry[] {
  return structuredClone(ingestSeqs.map((seq) => {
    const entry = publicFixture.records.find((item) => item.ingestSeq === seq);
    if (!entry) throw new Error(`No public Pi fixture record ${seq}`);
    return entry;
  }));
}

/** Rebind a projected public UA record to a test Chat/Submission. Event resource
 * identity follows the envelope; no event-only or top-level message is made up. */
export function nativeScopedFixture(ingestSeqs: readonly number[], scope: AgentResourceScope): NativeTrajectoryEntry[] {
  const object = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected Pi fixture object");
    return value as Record<string, unknown>;
  };
  return nativeFixture(...ingestSeqs).map((entry) => {
    const envelope = object(entry.record);
    object(envelope.resource).sessionId = scope.chatId;
    envelope.submissionId = scope.submissionId;
    const value = object(object(envelope.record).value);
    if (value.kind === "springbrand.trajectory" && object(value.data).type === "event") {
      const event = object(object(value.data).event);
      object(event.resource).sessionId = scope.chatId;
      event.submissionId = scope.submissionId;
    }
    return nativeTrajectoryEntrySchema.parse(entry);
  });
}

export function nativeResourceInput(ingestSeqs: readonly number[], patch: Partial<AgentResourceSnapshot> = {},
  ownerUserId = "owner-1"): ResourceInput {
  return resourceInput({
    scope: { chatId: "chat-1", submissionId: "submission-1", idempotencyKey: "key-1" },
    nativeRecords: nativeFixture(...ingestSeqs), ...patch,
  }, ownerUserId);
}

export function settlement(eventId: string, patch: AgentResourceFact = {}): AgentResourceFact {
  return {
    eventId, accountId: "account-1", status: "settled", ratedUnits: 10,
    debitedUnits: 8, shortfallUnits: 2, platformOwned: { units: 2, reason: "insufficient_balance" }, ...patch,
  };
}

export function sampling(samplingId = "sampling-1", patch: Partial<MetricsSampling> = {}): MetricsSampling {
  return {
    samplingId, projectId: PROJECT.projectId, projectSampleId: "ps-1", subjectAgent: SUBJECT,
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

/** A succeeded EvaluationRecord whose structured output is `result` written as JSON text (or raw text). */
export function evaluation(evaluationId = "evaluation-1", patch: Partial<MetricsEvaluation> = {}, result: JsonValue | string = { score: 80 }): MetricsEvaluation {
  return {
    evaluationId, samplingId: "sampling-1", evaluator: EVALUATOR, chatId: `judge:${evaluationId}`,
    status: { status: "succeeded" },
    attempts: [{
      evaluationAttemptId: `attempt:${evaluationId}`, evaluationId, attemptNumber: 1,
      submissionId: `judge-submission:${evaluationId}`, status: "completed",
      startedAt: "2026-10-08T00:00:02.000Z", completedAt: "2026-10-08T00:00:04.000Z",
      resources: collection({ scope: {
        chatId: `judge:${evaluationId}`, submissionId: `judge-submission:${evaluationId}`,
        idempotencyKey: `evaluation:${evaluationId}`,
      } }),
    }],
    output: {
      status: "succeeded",
      structuredOutput: {
        path: "/output/result.json",
        content: typeof result === "string" ? result : JSON.stringify(result),
      },
      artifacts: [{ artifactId: `report:${evaluationId}`, kind: "report", path: "/evaluation.json" }],
      evidenceRefs: [{ kind: "artifact", ref: "/workspace/page.html" }],
      trajectory: { trajectoryId: `trajectory:${evaluationId}`, source: "evaluator", path: "/judge-trajectory.json" },
    }, ...patch,
  };
}
