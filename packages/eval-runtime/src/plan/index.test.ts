import { describe, expect, it } from "vitest";
import type { ProjectDatasetSnapshot } from "@eval-platform/eval-contracts";
import { RuntimeInputError } from "../runtime/errors.js";
import type { ProjectSample } from "../runtime/model.js";
import {
  DEFAULT_RETRY_POLICY,
  digestEvaluationPlan,
  digestExecutionPlan,
  normalizeEvaluationPlan,
  normalizeExecutionPlan,
  phasesOf,
  type EvaluationPlanInput,
  type ExecutionPlanInput,
} from "./index.js";

const SUBJECT = { ownerUserId: "user-1", userAgentId: "subject-copy" };
const EVALUATOR = { ownerUserId: "user-1", userAgentId: "evaluator-copy" };

const execution: ExecutionPlanInput = {
  harness: { kind: "sp", framework: "sp", agentConfig: SUBJECT, runtime: { timeoutMs: 1_234 } },
  subjectAgentConfig: { sourceUserAgentId: "subject-agent", name: "Subject", body: { model: "a", tools: ["x"] } },
  executionConcurrency: 3,
};

const evaluation: EvaluationPlanInput = {
  evaluationHarness: { kind: "sp", framework: "sp", agentConfig: EVALUATOR },
  evaluatorAgentConfig: { sourceUserAgentId: "evaluator-agent", name: "Evaluator", body: { model: "b" } },
  evaluationConcurrency: 2,
  outputSchema: { outputSchemaId: "schema-1", digest: "a".repeat(64) },
};

const datasets: readonly ProjectDatasetSnapshot[] = [
  { datasetId: "dataset-1", name: "One", kind: "general", projectSampleIds: ["ps-2", "ps-1"] },
];

function sample(projectSampleId: string, userPrompt = `Run ${projectSampleId}`): ProjectSample {
  return {
    projectSampleId,
    projectId: "project-1",
    dataId: `data-${projectSampleId}`,
    datasetIds: ["dataset-1"],
    samplingCount: 2,
    data: { dataId: `data-${projectSampleId}`, userPrompt, json: { a: 1, b: { c: 2, d: 3 } } },
  };
}

describe("project plan", () => {
  it("derives Run phases from the operation", () => {
    expect(phasesOf("execution")).toEqual(["execution"]);
    expect(phasesOf("evaluation")).toEqual(["evaluation"]);
    expect(phasesOf("pipeline")).toEqual(["execution", "evaluation"]);
  });

  it("defaults the retry policy and returns detached normalized values", () => {
    const normalized = normalizeExecutionPlan(execution);
    expect(normalized).toEqual({ ...execution, retryPolicy: DEFAULT_RETRY_POLICY });
    expect(normalized.retryPolicy).not.toBe(DEFAULT_RETRY_POLICY);
    expect(normalized.harness).not.toBe(execution.harness);
    expect(normalized.harness.agentConfig).not.toBe(execution.harness.agentConfig);
    expect(normalizeEvaluationPlan(evaluation).retryPolicy).toEqual(DEFAULT_RETRY_POLICY);
    const retryPolicy = { maxRestarts: 0, initialBackoffMs: 0, maxBackoffMs: 0 };
    expect(normalizeExecutionPlan({ ...execution, retryPolicy }).retryPolicy).toEqual(retryPolicy);
  });

  it.each(["sp", "codex", "cc"] as const)("preserves the %s Subject framework", (framework) => {
    const harness = { ...execution.harness, framework };
    expect(normalizeExecutionPlan({ ...execution, harness }).harness).toEqual(harness);
  });

  it.each([undefined, null, [], {}, "claude-code", ""])(
    "rejects a missing or unsupported framework %j without defaulting to SP",
    (framework) => {
      const harness = { ...execution.harness, framework } as unknown as ExecutionPlanInput["harness"];
      expect(() => normalizeExecutionPlan({ ...execution, harness })).toThrow(
        "execution.harness.framework must be one of sp, codex, cc",
      );
    },
  );

  it.each(["codex", "cc"] as const)("requires the SP framework for a %s Evaluator", (framework) => {
    const evaluationHarness = { ...evaluation.evaluationHarness, framework } as unknown as EvaluationPlanInput["evaluationHarness"];
    expect(() => normalizeEvaluationPlan({ ...evaluation, evaluationHarness })).toThrow(
      "evaluationHarness must use the SP framework",
    );
  });

  it("rejects a Harness that is not hosted by SP", () => {
    const harness = { ...execution.harness, kind: "local" } as unknown as ExecutionPlanInput["harness"];
    expect(() => normalizeExecutionPlan({ ...execution, harness })).toThrow(RuntimeInputError);
    expect(() => normalizeExecutionPlan({ ...execution, harness })).toThrow("execution.harness.kind must be sp");
  });

  it.each([
    [{ ...execution, executionConcurrency: 0 }, "execution.executionConcurrency"],
    [{ ...execution, retryPolicy: { maxRestarts: -1, initialBackoffMs: 0, maxBackoffMs: 0 } }, "retryPolicy.maxRestarts"],
    [{ ...execution, harness: { ...execution.harness, runtime: [] } }, "execution.harness.runtime"],
    [{ ...execution, harness: { ...execution.harness, runtime: { timeoutMs: 0 } } }, "execution.harness.runtime.timeoutMs"],
    [{ ...execution, subjectAgentConfig: { ...execution.subjectAgentConfig, body: [] } }, "execution.subjectAgentConfig.body"],
  ])("rejects invalid execution plan input %#", (input, field) => {
    expect(() => normalizeExecutionPlan(input as unknown as ExecutionPlanInput)).toThrow(expect.objectContaining({
      name: "RuntimeInputError", field,
    }));
  });

  it.each([
    [{ ...evaluation, evaluationConcurrency: 1.5 }, "evaluation.evaluationConcurrency"],
    [{ ...evaluation, outputSchema: { outputSchemaId: "", digest: "x" } }, "evaluation.outputSchema.outputSchemaId"],
    [{ ...evaluation, outputSchema: null }, "evaluation.outputSchema"],
  ])("rejects invalid evaluation plan input %#", (input, field) => {
    expect(() => normalizeEvaluationPlan(input as unknown as EvaluationPlanInput)).toThrow(expect.objectContaining({
      name: "RuntimeInputError", field,
    }));
  });

  it("digests the execution plan independently of object key order and ProjectSample order", async () => {
    const plan = normalizeExecutionPlan(execution);
    const reordered = {
      retryPolicy: { maxBackoffMs: plan.retryPolicy.maxBackoffMs, initialBackoffMs: plan.retryPolicy.initialBackoffMs, maxRestarts: plan.retryPolicy.maxRestarts },
      executionConcurrency: plan.executionConcurrency,
      subjectAgentConfig: { body: { tools: ["x"], model: "a" }, name: "Subject", sourceUserAgentId: "subject-agent" },
      harness: { runtime: { timeoutMs: 1_234 }, agentConfig: { userAgentId: SUBJECT.userAgentId, ownerUserId: SUBJECT.ownerUserId }, framework: "sp", kind: "sp" },
    } as const;
    const first = await digestExecutionPlan({ execution: plan, datasets, samples: [sample("ps-1"), sample("ps-2")] });
    const second = await digestExecutionPlan({ execution: reordered, datasets, samples: [sample("ps-2"), sample("ps-1")] });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    await expect(digestExecutionPlan({ execution: plan, datasets, samples: [sample("ps-1", "changed"), sample("ps-2")] }))
      .resolves.not.toBe(first);
    await expect(digestExecutionPlan({ execution: { ...plan, executionConcurrency: 4 }, datasets, samples: [sample("ps-1"), sample("ps-2")] }))
      .resolves.not.toBe(first);
  });

  it("digests the evaluation plan independently of object key order", async () => {
    const plan = normalizeEvaluationPlan(evaluation);
    const digest = await digestEvaluationPlan(plan);
    const { outputSchema, ...rest } = plan;
    await expect(digestEvaluationPlan({ outputSchema: { digest: outputSchema.digest, outputSchemaId: outputSchema.outputSchemaId }, ...rest }))
      .resolves.toBe(digest);
    await expect(digestEvaluationPlan({ ...plan, evaluationConcurrency: 5 })).resolves.not.toBe(digest);
  });
});
