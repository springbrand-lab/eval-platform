import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "@eval-platform/eval-contracts";
import type {
  ConfigStore,
  EvaluationConfig,
  ExecutionConfig,
  PipelineConfig,
} from "./model.js";
import {
  DEFAULT_RETRY_POLICY,
  createConfigResolver,
  createEvaluationConfig,
  createExecutionConfig,
  createPipelineConfig,
} from "./index.js";

const SUBJECT = { ownerUserId: "user-1", userAgentId: "subject-agent" };
const EVALUATOR = { ownerUserId: "user-1", userAgentId: "evaluator-agent" };

const executionConfig: ExecutionConfig = {
  configId: "execution-1",
  datasetId: "dataset-1",
  sampleIds: ["sample-2", "sample-1"],
  samplingCount: 2,
  executionConcurrency: 3,
  harness: { kind: "sp", framework: "sp", agentConfig: SUBJECT },
};

const evaluationConfig: EvaluationConfig = {
  configId: "evaluation-1",
  evaluationHarness: { kind: "sp", framework: "sp", agentConfig: EVALUATOR },
  evaluationConcurrency: 2,
};

const pipelineConfig: PipelineConfig = {
  configId: "pipeline-1",
  executionConfigId: executionConfig.configId,
  evaluationConfigId: evaluationConfig.configId,
};

function makeStore(): ConfigStore {
  return {
    async getExecutionConfig(configId) {
      return configId === executionConfig.configId ? executionConfig : null;
    },
    async getEvaluationConfig(configId) {
      return configId === evaluationConfig.configId ? evaluationConfig : null;
    },
    async getPipelineConfig(configId) {
      return configId === pipelineConfig.configId ? pipelineConfig : null;
    },
  };
}

describe("runtime config", () => {
  it("generates config ids in code", () => {
    let nextId = 0;
    const idFactory = () => `config-${++nextId}`;

    expect(createExecutionConfig({
      datasetId: "dataset-1",
      samplingCount: 1,
      executionConcurrency: 1,
      harness: { kind: "sp", framework: "sp", agentConfig: SUBJECT },
    }, idFactory).configId).toBe("config-1");
    expect(createEvaluationConfig({
      evaluationHarness: { kind: "sp", framework: "sp", agentConfig: EVALUATOR },
      evaluationConcurrency: 1,
    }, idFactory).configId).toBe("config-2");
    expect(createPipelineConfig({
      executionConfigId: "execution-1",
      evaluationConfigId: "evaluation-1",
    }, idFactory).configId).toBe("config-3");
  });

  it("resolves a pipeline into validated execution and evaluation config", async () => {
    const resolver = createConfigResolver(makeStore());

    await expect(resolver.resolvePipelineConfig("pipeline-1")).resolves.toEqual({
      pipeline: pipelineConfig,
      execution: {
        ...executionConfig,
        sampleIds: ["sample-2", "sample-1"],
        retryPolicy: DEFAULT_RETRY_POLICY,
      },
      evaluation: {
        ...evaluationConfig,
        retryPolicy: DEFAULT_RETRY_POLICY,
      },
    });
  });

  it("returns detached normalized config values", async () => {
    const resolver = createConfigResolver(makeStore());
    const resolved = await resolver.resolveExecutionConfig("execution-1");

    expect(resolved).not.toBe(executionConfig);
    expect(resolved.harness).not.toBe(executionConfig.harness);
    expect(resolved.harness).toEqual(executionConfig.harness);
    expect(resolved.sampleIds).not.toBe(executionConfig.sampleIds);
    expect(resolved.retryPolicy).toEqual(DEFAULT_RETRY_POLICY);
  });

  it.each(["sp", "codex", "cc"] as const)(
    "preserves the %s framework in created and resolved execution configs",
    async (framework) => {
      const storedConfig: ExecutionConfig = {
        ...executionConfig,
        harness: {
          kind: "sp",
          framework,
          agentConfig: SUBJECT,
          runtime: { timeoutMs: 1_234 },
        },
      };
      const { configId, ...input } = storedConfig;
      const created = createExecutionConfig(input, () => configId);
      const resolver = createConfigResolver({
        ...makeStore(),
        async getExecutionConfig() {
          return storedConfig;
        },
      });
      const resolved = await resolver.resolveExecutionConfig(configId);

      expect(created.harness).toEqual(storedConfig.harness);
      expect(resolved.harness).toEqual(storedConfig.harness);
      expect(resolved.harness).not.toBe(storedConfig.harness);
      if (resolved.harness.kind !== "sp" || storedConfig.harness.kind !== "sp") {
        throw new Error("expected the SP host");
      }
      expect(resolved.harness.agentConfig).not.toBe(storedConfig.harness.agentConfig);
      expect(resolved.harness.runtime).not.toBe(storedConfig.harness.runtime);
    },
  );

  it("rejects the obsolete workspace mode so evaluator binding is explicit", () => {
    expect(() => createEvaluationConfig({
      evaluationHarness: {
        kind: "sp",
        framework: "sp",
        agentConfig: EVALUATOR,
        runtime: { workspaceMode: "isolated" },
      } as unknown as EvaluationConfig["evaluationHarness"],
      evaluationConcurrency: 1,
    })).toThrow("evaluationHarness.runtime.workspaceMode is no longer supported");
  });

  it.each([
    { framework: undefined },
    { framework: null },
    { framework: [] },
    { framework: {} },
    { framework: "claude-code" },
    { framework: "remote" },
    { framework: "" },
  ])(
    "rejects a missing or unsupported framework %j without defaulting to SP",
    async ({ framework }) => {
      const invalidConfig = {
        ...executionConfig,
        harness: { kind: "sp", framework, agentConfig: SUBJECT },
      } as unknown as ExecutionConfig;
      const { configId, ...input } = invalidConfig;
      const resolver = createConfigResolver({
        ...makeStore(),
        async getExecutionConfig() {
          return invalidConfig;
        },
      });

      expect(() => createExecutionConfig(input)).toThrow(
        "harness.framework must be sp, codex or cc",
      );
      await expect(resolver.resolveExecutionConfig(configId)).rejects.toThrow(
        "harness.framework must be sp, codex or cc",
      );
      await expect(resolver.resolvePipelineConfig(pipelineConfig.configId)).rejects.toThrow(
        "harness.framework must be sp, codex or cc",
      );
    },
  );

  it.each([
    { kind: "sp", framework: "codex", agentConfig: EVALUATOR },
    { kind: "sp", framework: "cc", agentConfig: EVALUATOR },
    { kind: "remote", provider: "provider-1", agentRef: "agent-1" },
  ])("rejects a non-SP evaluator %j", async (evaluationHarness) => {
    const invalidConfig = { ...evaluationConfig, evaluationHarness } as unknown as EvaluationConfig;
    const { configId, ...input } = invalidConfig;
    const resolver = createConfigResolver({
      ...makeStore(),
      async getEvaluationConfig() {
        return invalidConfig;
      },
    });

    expect(() => createEvaluationConfig(input)).toThrow(
      "evaluationHarness must use the SP host and framework",
    );
    await expect(resolver.resolveEvaluationConfig(configId)).rejects.toThrow(
      "evaluationHarness must use the SP host and framework",
    );
    await expect(resolver.resolvePipelineConfig(pipelineConfig.configId)).rejects.toThrow(
      "evaluationHarness must use the SP host and framework",
    );
  });

  it("rejects unknown and invalid configs before Runtime starts", async () => {
    const resolver = createConfigResolver({
      ...makeStore(),
      async getExecutionConfig(configId) {
        if (configId === "invalid") {
          return {
            ...executionConfig,
            samplingCount: 0,
          };
        }
        return makeStore().getExecutionConfig(configId);
      },
    });

    await expect(resolver.resolveExecutionConfig("missing")).rejects.toThrow(
      "Unknown execution config missing",
    );
    await expect(resolver.resolveExecutionConfig("invalid")).rejects.toThrow(
      "samplingCount must be a positive integer",
    );
    await expect(resolver.resolvePipelineConfig("missing")).rejects.toThrow(
      "Unknown pipeline config missing",
    );
  });

  it.each([
    { arrayOptions: [] },
    { arrayOptions: [{ timeoutMs: 1_234 }] },
  ])("rejects array options %j", async ({ arrayOptions }) => {
    const invalidRuntime = {
      ...executionConfig,
      harness: {
        kind: "sp",
        framework: "sp",
        agentConfig: SUBJECT,
        runtime: arrayOptions,
      },
    } as unknown as ExecutionConfig;
    const invalidRunOptions = {
      ...executionConfig,
      harness: {
        kind: "remote",
        provider: "provider-1",
        agentRef: "agent-1",
        runOptions: arrayOptions,
      } as unknown as HarnessConfig,
    };
    const resolver = createConfigResolver({
      ...makeStore(),
      async getExecutionConfig(configId) {
        if (configId === "invalid-runtime") return invalidRuntime;
        if (configId === "invalid-run-options") return invalidRunOptions;
        return makeStore().getExecutionConfig(configId);
      },
    });

    await expect(resolver.resolveExecutionConfig("invalid-runtime")).rejects.toThrow(
      "harness.runtime must be an object",
    );
    await expect(resolver.resolveExecutionConfig("invalid-run-options")).rejects.toThrow(
      "harness.runOptions must be an object",
    );
  });
});
