import { describe, expect, it } from "vitest";
import type { Data } from "@/api-sdk/types";
import { buildProjectInput, type ProjectDraft } from "./new-project-page";
import { inputLimits } from "@/test/input-limits";

const data = (dataId: string, evalPrompt?: string) => ({ dataId, userPrompt: `do ${dataId}`, ...(evalPrompt ? { evalPrompt } : {}) }) as Data;
const members = new Map([["ds-1", [data("a", "judge"), data("b", "judge")]], ["ds-2", [data("b", "judge"), data("c")]]]);

function draft(patch: Partial<ProjectDraft> = {}): ProjectDraft {
  return {
    name: " Hello ", description: "", datasets: new Map([["ds-1", { dataIds: null }]]), samplingCount: 2, samplingCounts: {},
    subjectAgentId: "agent-s", executionConcurrency: 2, executionTimeoutMinutes: "",
    withEvaluation: true, evaluatorAgentId: "agent-e", evaluationConcurrency: 1, outputSchemaId: "schema-1", firstRun: "pipeline",
    ...patch,
  };
}

describe("Project creation body", () => {
  it("builds the request with whole and partial Datasets, overrides and an evaluation plan", () => {
    const body = buildProjectInput(draft({
      datasets: new Map([["ds-1", { dataIds: null }], ["ds-2", { dataIds: new Set(["c"]) }]]),
      samplingCounts: { a: 2, c: 5, zzz: 9 },
      executionTimeoutMinutes: "1.5",
    }), "key-1", members, inputLimits);
    expect(body).toEqual({
      idempotencyKey: "key-1",
      name: "Hello",
      datasets: [{ datasetId: "ds-1" }, { datasetId: "ds-2", dataIds: ["c"] }],
      samplingCount: 2,
      samplingCounts: { c: 5 },
      execution: { userAgentId: "agent-s", framework: "sp", executionConcurrency: 2, timeoutMs: 90_000 },
      evaluation: { userAgentId: "agent-e", evaluationConcurrency: 1, outputSchemaId: "schema-1" },
      run: { operation: "pipeline" },
    });
  });

  it.each([
    [{ name: " " }, "名称"],
    [{ datasets: new Map() }, "至少选择一个测试集"],
    [{ datasets: new Map([["ds-1", { dataIds: new Set<string>() }]]) }, "没有勾选"],
    [{ samplingCount: 0 }, "默认采样次数"],
    [{ subjectAgentId: "" }, "执行 Agent"],
    [{ outputSchemaId: "" }, "评分格式"],
    [{ executionTimeoutMinutes: "1e308" }, "超时时间"],
    [{ executionTimeoutMinutes: "0.0000001" }, "超时时间"],
    [{ withEvaluation: false, firstRun: "pipeline" as const }, "评估计划"],
  ])("explains %j", (patch, message) => {
    expect(buildProjectInput(draft(patch), "k", members, inputLimits)).toEqual(expect.stringContaining(message));
  });

  it("omits the evaluation plan for an execution-only Project", () => {
    const body = buildProjectInput(draft({ withEvaluation: false, firstRun: "execution" }), "k", members, inputLimits);
    expect(body).toMatchObject({ run: { operation: "execution" } });
    expect(body).not.toHaveProperty("evaluation");
  });
});
