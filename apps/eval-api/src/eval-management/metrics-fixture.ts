import type { MetricSummary } from "@eval-platform/eval-metrics";
import { DATASET, project, run } from "./test-fixture.js";

/** Model-visible projection tests include deliberately private, non-metric fields. */
export const summary = {
  counts: { datasets: 1, data: 2, projectSamples: 2, samplings: 1, evaluations: 1 },
  execution: { records: 1, statuses: { succeeded: 1 }, successRate: 1, attempts: 1, restarts: 0,
    agentDurationMs: { mean: 200 }, lastError: "hidden stage error" },
  evaluation: { records: 1, statuses: { succeeded: 1 }, successRate: 1, attempts: 1, restarts: 0,
    agentDurationMs: { mean: 100 } },
  executionAgent: { coverage: "complete", collections: { collected: 1 },
    tokens: { total: { value: 50, coverage: "complete" } },
    costs: { chargedUnits: { value: 3, coverage: "partial" } },
    cacheHitRate: { value: 0, coverage: "complete" },
    trajectory: { toolSuccessRate: { value: 0.5, coverage: "complete" }, byTool: [
      { toolName: null, count: { value: null, coverage: "partial" },
        completed: 0, failed: 0, cancelled: 0, inProgress: 0, unknown: 1,
        toolSuccessRate: { value: null, coverage: "partial" } },
      { toolName: "browser", count: { value: 2, coverage: "complete" },
        completed: 1, failed: 1, cancelled: 0, inProgress: 0, unknown: 0,
        toolSuccessRate: { value: 0.5, coverage: "complete" },
        inputLength: { secret: "private Tool arguments" } },
      { toolName: "search", count: { value: 1, coverage: "partial" },
        completed: 0, failed: 0, cancelled: 1, inProgress: 0, unknown: 0,
        toolSuccessRate: { value: 0, coverage: "partial" } },
    ] },
    diagnostics: [{ message: "private raw resource snapshot" }] },
  evaluationAgents: { coverage: "partial", collections: { collected: 1 },
    tokens: { total: { value: 20, coverage: "partial" } },
    costs: { chargedUnits: { value: 1, coverage: "complete" } },
    cacheHitRate: { value: null, coverage: "unavailable" },
    trajectory: { toolSuccessRate: { value: null, coverage: "unavailable" }, byTool: [
      { toolName: "evaluator_tool", count: { value: null, coverage: "unavailable" },
        completed: 0, failed: 0, cancelled: 0, inProgress: 0, unknown: 1,
        toolSuccessRate: { value: null, coverage: "unavailable" } },
    ] } },
  evaluationOutputs: { evaluations: 1, validation: { valid: 1 }, fields: [{
    jsonPointer: "/score", title: "Score", description: "private schema description",
    kinds: ["integer"], observationCount: 1, contributingEvaluationCount: 1,
    missingEvaluationCount: 0, numeric: { mean: 8, median: 8 },
    distribution: [{ value: 8, count: 1, share: 1 }], coverage: "complete",
  }] },
} as unknown as MetricSummary;

export const detail = {
  project, summary, runIds: [run.runId],
  projectSample: {
    projectSampleId: "sample-1", projectId: project.projectId, dataId: DATASET,
    datasetIds: [DATASET], samplingCount: 2, data: { userPrompt: "private Subject prompt" },
  },
  sampling: {
    samplingId: "sampling-1", projectId: project.projectId, projectSampleId: "sample-1",
    subjectAgent: { ownerUserId: project.ownerUserId, userAgentId: "subject-agent" },
    subjectChatId: "subject-chat", execution: { status: "succeeded", lastError: "private error" },
    evidence: { evidenceId: "sha256:proof", manifestSha256: "a".repeat(64) },
    artifacts: [{ artifactId: "artifact-1", kind: "file", path: "/workspace/private.txt" }],
    trajectory: { trajectoryId: "trajectory-1", source: "subject", path: "/private" },
  },
  subject: {
    role: "subject", samplingId: "sampling-1", evaluationId: null, chatId: "subject-chat",
    agentConfigRef: { ownerUserId: project.ownerUserId, userAgentId: "subject-agent" },
    resources: summary.executionAgent,
  },
  evaluations: [{
    record: { evaluationId: "evaluation-1", samplingId: "sampling-1", chatId: "evaluator-chat",
      evaluator: { ownerUserId: project.ownerUserId, userAgentId: "evaluator-agent" },
      status: { status: "succeeded", lastError: "private" } },
    agent: { role: "evaluator", samplingId: "sampling-1", evaluationId: "evaluation-1", chatId: "evaluator-chat",
      agentConfigRef: { ownerUserId: project.ownerUserId, userAgentId: "evaluator-agent" },
      resources: summary.evaluationAgents },
    output: {
      evaluationId: "evaluation-1", samplingId: "sampling-1",
      validation: { status: "valid", reason: "valid", errors: [] },
      content: `{"score":8,"explanation":"${"private explanation ".repeat(150)}"}`,
      contentHash: "b".repeat(64), path: "/output/result.json",
      outputStatus: "succeeded", rawJson: { score: 8, explanation: "private explanation ".repeat(150) },
      artifacts: [{ artifactId: "artifact-2", kind: "file", path: "/workspace/private-output.txt" }],
      evidenceRefs: [{ kind: "artifact", ref: "/workspace/proof.txt" },
        { kind: "workspace", ref: "https://signed.test/credential?token=private" }],
      trajectory: { trajectoryId: "trajectory-2", source: "evaluator", path: "/private" },
    },
  }],
};
