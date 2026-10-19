import type { EvaluationRecord, ProjectDatasetSnapshot, RunOperation, RunTargetSelector, Sampling } from "@eval-platform/eval-contracts";
import type { Data } from "@eval-platform/eval-dataset";
import type { ProjectPlanReader, ProjectSample, RuntimeRunAdmissionCommand, RuntimeStore } from "@eval-platform/eval-runtime";
import {
  digestJson,
  digestExecutionPlan,
  normalizeEvaluationPlan,
  normalizeExecutionPlan,
  phasesOf,
} from "@eval-platform/eval-runtime";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import type { EvalSpAgentConfig, EvalSpClient } from "../sp/client.js";
import { EvalSpApiError } from "../sp/http.js";
import type { EvalDb } from "./client.js";
import { createOutputSchemaCatalog } from "./output-schemas.js";
import { planProjectSampleIds } from "@eval-platform/eval-runtime";
import { bindProjectSamples } from "../projects/snapshot.js";
import { createPostgresProjectStore } from "./project-store.js";
import { projectEvaluationPlans } from "./schema.js";

export const release = { sourceBranch: "release-2.0.0", sourceCommit: "a".repeat(40) };
const retryPolicy = { maxRestarts: 1, initialBackoffMs: 250, maxBackoffMs: 10_000 };

/** An in-memory Eval SP whose Bearer token is the user ID; records every Agent Config call. */
export function createStubSp() {
  const configs = new Map<string, EvalSpAgentConfig>();
  const mcpServers = [{
    id: "eval-results", source: "user", status: "active",
    url: "https://eval.example/mcp/evaluation-results", authType: "bearer",
  }] as const;
  const calls = { created: [] as Array<Record<string, unknown>>, deleted: [] as string[] };
  function owned(token: string, id: string): EvalSpAgentConfig {
    const config = configs.get(id);
    if (!config || config.user_id !== token) throw new EvalSpApiError(404, { code: "NOT_FOUND", errMsg: "Agent Config not found" });
    return config;
  }
  const sp = {
    verifySession: vi.fn(async (token: string) => ({ id: token, role: "user" as const })),
    listAgentConfigs: vi.fn(async (token: string) => [...configs.values()].filter((config) => config.user_id === token)),
    listMcpServers: vi.fn(async () => mcpServers),
    getAgentConfig: vi.fn(async (token: string, id: string) => structuredClone(owned(token, id))),
    createAgentConfig: vi.fn(async (token: string, input: unknown) => {
      const body = input as Record<string, unknown>;
      calls.created.push(body);
      const config = { ...body, id: crypto.randomUUID(), user_id: token, name: String(body.name), revision: 1, is_default: false };
      configs.set(config.id, config);
      return structuredClone(config);
    }),
    updateAgentConfig: vi.fn(async (token: string, id: string, input: unknown) => {
      const config = { ...owned(token, id), ...(input as object) };
      configs.set(id, config);
      return structuredClone(config);
    }),
    deleteAgentConfig: vi.fn(async (token: string, id: string) => {
      owned(token, id);
      calls.deleted.push(id);
      configs.delete(id);
      return { id };
    }),
  };
  return {
    sp: sp as typeof sp & EvalSpClient,
    calls,
    configs,
    /** A user-editable Agent Config. */
    seed(owner: string, name: string, setting: Record<string, unknown> = { model: name }): string {
      const id = crypto.randomUUID();
      configs.set(id, { id, user_id: owner, slug: name.toLowerCase(), name, description: `${name} description`, revision: 3, setting, is_default: false });
      return id;
    },
  };
}

/**
 * Writes a Project snapshot directly, without SP copies, for Store-level tests. Each Dataset lists
 * its Data; Data repeated across Datasets becomes one ProjectSample.
 */
export async function seedProject(db: EvalDb, owner: string, input: {
  readonly datasets: ReadonlyArray<{ readonly datasetId?: string; readonly data: readonly Data[] }>;
  readonly samplingCount?: number;
  readonly evaluation?: boolean;
  readonly locked?: boolean;
}): Promise<{ projectId: string; samples: ProjectSample[]; datasets: ProjectDatasetSnapshot[] }> {
  const projectId = crypto.randomUUID();
  const { datasets, samples: values } = bindProjectSamples({
    projectId,
    datasets: input.datasets.map((dataset, index) => ({
      dataset: { datasetId: dataset.datasetId ?? crypto.randomUUID(), name: `Dataset ${index}`, kind: "general" as const },
      data: dataset.data,
    })),
    samplingCountOf: () => input.samplingCount ?? 1,
  });
  const subject = { sourceUserAgentId: "source-subject", name: "Subject", body: { name: "Subject" } };
  const evaluator = { sourceUserAgentId: "source-evaluator", name: "Evaluator", body: { name: "Evaluator" } };
  const execution = normalizeExecutionPlan({
    harness: { kind: "sp", framework: "sp", agentConfig: { ownerUserId: owner, userAgentId: `subject-${projectId}` } },
    subjectAgentConfig: subject, executionConcurrency: 1, retryPolicy,
  });
  const store = createPostgresProjectStore(db, owner);
  let evaluation = null;
  if (input.evaluation) {
    const { outputSchemaId, schema } = await createOutputSchemaCatalog(db, owner).create({
      name: "Score", description: "Score", content: JSON.stringify({ type: "object", properties: { score: { type: "number" } } }),
    });
    const plan = normalizeEvaluationPlan({
      evaluationHarness: { kind: "sp", framework: "sp", agentConfig: { ownerUserId: owner, userAgentId: `evaluator-${projectId}` } },
      evaluatorAgentConfig: evaluator, evaluationConcurrency: 1, retryPolicy, outputSchema: { outputSchemaId, digest: await digestJson(schema) },
    });
    evaluation = { plan, digest: await digestJson(plan) };
  }
  await store.create({
    project: { projectId, ownerUserId: owner, name: "Project", sourceBranch: release.sourceBranch, createdAt: new Date().toISOString() },
    datasets, samples: values,
    execution: { plan: execution, digest: await digestExecutionPlan({ execution, datasets, samples: values }) },
    evaluation,
    agentConfigs: [
      { userAgentId: `subject-${projectId}`, role: "subject", snapshot: subject },
      ...(evaluation ? [{ userAgentId: `evaluator-${projectId}`, role: "evaluator" as const, snapshot: evaluator }] : []),
    ],
    creation: { key: `create-${projectId}`, fingerprint: "fingerprint" },
  });
  if (input.locked) {
    await db.update(projectEvaluationPlans).set({ lockedAt: new Date() }).where(eq(projectEvaluationPlans.projectId, projectId));
  }
  return { projectId, samples: values, datasets };
}

export function makeData(userPrompt = "task"): Data {
  return { dataId: crypto.randomUUID(), userPrompt, evalPrompt: "judge" };
}

/**
 * Builds an admission command the way Runtime does: execution/pipeline replace every current Sampling
 * of the target ProjectSamples plus the target Samplings; evaluation reuses the target Samplings.
 */
export async function buildCommand(plans: ProjectPlanReader, store: RuntimeStore, input: {
  readonly projectId: string;
  readonly operation: RunOperation;
  readonly projectSampleIds?: readonly string[];
  readonly samplingIds?: readonly string[];
  readonly idempotencyKey?: string;
  readonly requestFingerprint?: string;
  readonly selector?: RunTargetSelector;
}): Promise<RuntimeRunAdmissionCommand> {
  const plan = await plans.getProjectPlan(input.projectId);
  if (!plan) throw new Error(`Unknown Project ${input.projectId}`);
  const evaluates = input.operation !== "execution";
  const projectSampleIds = input.operation === "evaluation" ? []
    : input.projectSampleIds ?? (input.samplingIds === undefined ? planProjectSampleIds(plan) : []);
  let samplingIds = [...input.samplingIds ?? []];
  if (input.operation === "evaluation" && input.samplingIds === undefined) {
    samplingIds = (await store.listProjectSamplings(input.projectId, planProjectSampleIds(plan)))
      .filter((sampling) => sampling.execution.status === "succeeded").map((sampling) => sampling.samplingId);
  }
  const targets = { projectSampleIds, samplingIds };
  let samplings: Sampling[] = [];
  let replacedSamplingIds: string[] = [];
  let runSamplingIds = samplingIds;
  if (input.operation !== "evaluation") {
    const current = await store.listProjectSamplings(input.projectId, projectSampleIds);
    const targetSamplings = (await store.getSamplings(samplingIds)).filter((sampling) => sampling !== null);
    replacedSamplingIds = [...current, ...targetSamplings].map((sampling) => sampling.samplingId);
    const samples = (await plans.getProjectSamples(input.projectId, projectSampleIds)).filter((sample) => sample !== null);
    const agent = plan.execution.harness.agentConfig;
    const fresh = (projectSampleId: string): Sampling => ({
      samplingId: crypto.randomUUID(), projectId: input.projectId, projectSampleId,
      execution: { status: "queued" }, subjectAgent: agent, executionAttempts: [],
    });
    samplings = [
      ...samples.flatMap((sample) => Array.from({ length: sample.samplingCount }, () => fresh(sample.projectSampleId))),
      ...targetSamplings.map((sampling) => fresh(sampling.projectSampleId)),
    ];
    runSamplingIds = samplings.map((sampling) => sampling.samplingId);
  }
  const evaluator = plan.evaluation?.plan.evaluationHarness.agentConfig ?? { ownerUserId: "none", userAgentId: "none" };
  const evaluations: EvaluationRecord[] = evaluates ? runSamplingIds.map((samplingId) => ({
    evaluationId: crypto.randomUUID(), samplingId, evaluator, status: { status: "queued" }, attempts: [],
  })) : [];
  return {
    run: {
      runId: crypto.randomUUID(), projectId: input.projectId, sourceCommit: release.sourceCommit,
      operation: input.operation, phases: phasesOf(input.operation), selector: input.selector ?? { all: true }, targets,
      samplingIds: runSamplingIds, evaluationIds: evaluations.map((evaluation) => evaluation.evaluationId),
      planDigests: {
        execution: plan.executionPlanDigest,
        ...(evaluates && plan.evaluation ? { evaluation: plan.evaluation.digest } : {}),
      },
      requestIdentity: { idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(), requestFingerprint: input.requestFingerprint ?? "facts" },
    },
    replacedSamplingIds,
    samplings,
    evaluations,
  };
}

/** Marks Samplings and their Evaluations with one status, as a Worker pass would. */
export async function settle(store: RuntimeStore, samplingIds: readonly string[], status: "succeeded" | "failed" | "cancelled") {
  for (const sampling of await store.getSamplings(samplingIds)) {
    if (!sampling) continue;
    await store.updateSampling({ ...sampling, execution: { status } }, sampling);
    for (const evaluation of await store.listEvaluations(sampling.samplingId)) {
      await store.updateEvaluation({ ...evaluation, status: { status } }, evaluation);
    }
  }
}
