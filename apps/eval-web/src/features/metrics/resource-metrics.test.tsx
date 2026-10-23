import { describe, expect, it } from "vitest";
import type { EvaluationOutputSummary } from "@/api-sdk/types";
import { render } from "@/test/render";
import { aggregatedResourceStatistics, agentMetric, metricSummary, resourceStatistics } from "@/test/metrics";
import { AgentPanel } from "@/features/results/agent-panel";
import { ResourceMetrics, stageStatusFor } from "./resource-metrics";
import { OutputFields, SummaryCards } from "./summary";

function fixture() {
  const base = resourceStatistics();
  return resourceStatistics({ trajectory: {
    ...base.trajectory, coverage: "partial",
    turns: { ...base.trajectory.turns, count: { value: 4, coverage: "partial" }, completed: 2, failed: 1, unknown: 1 },
    tools: { ...base.trajectory.tools, count: { value: 3, coverage: "partial" }, completed: 2, failed: 1 },
    thinkingSteps: { value: 2, coverage: "partial" },
    thinkingStepOperations: { ...base.trajectory.thinkingStepOperations, count: { value: 2, coverage: "partial" }, completed: 1, failed: 1 },
    contentSteps: { value: 1, coverage: "partial" },
    contentStepOperations: { ...base.trajectory.contentStepOperations, count: { value: 1, coverage: "partial" }, completed: 1 },
    thinkingStepTokens: { input: { value: 160, coverage: "partial" }, output: { value: 40, coverage: "partial" }, total: { value: 200, coverage: "partial" } },
    contentStepTokens: { input: { value: 80, coverage: "partial" }, output: { value: null, coverage: "unavailable" }, total: { value: null, coverage: "unavailable" } },
    byTool: [{
      ...base.trajectory.tools, toolName: "write_file", count: { value: 3, coverage: "partial" }, completed: 2, failed: 1,
      durationMs: { count: 3, missing: 0, total: 600, min: 100, max: 300, mean: 200, variance: 6666.666666666667, median: 200 },
      inputLength: { count: 3, missing: 0, total: 480, min: 100, max: 200, mean: 160, variance: 1866.6666666666667, median: 180, coverage: "partial" },
      outputLength: { count: 0, missing: 3, total: null, min: null, max: null, mean: null, variance: null, median: null, coverage: "unavailable" },
    }],
    unlinkedOperations: { tools: 1, generations: 2 },
  } });
}

describe("Agent resource and trajectory categories", () => {
  it("does not show native unknown coverage as known zero in operation or billing cells", async () => {
    const base = resourceStatistics();
    const unknown = { ...base.modelRequests, count: { value: null, coverage: "unavailable" as const } };
    const statistics = resourceStatistics({
      coverage: "unavailable", modelRequests: unknown,
      costs: { ...base.costs, chargedUnits: { value: 0, coverage: "unavailable" } },
      trajectory: { ...base.trajectory, coverage: "unavailable", turns: unknown, tools: unknown,
        modelInvocations: unknown, deferredPolls: unknown, compactions: unknown,
        generationTasks: { value: 0, coverage: "unavailable" },
        requestRetries: { generation: { value: 0, coverage: "partial" }, compaction: { value: 0, coverage: "unavailable" } },
        thinkingStepOperations: unknown, contentStepOperations: unknown,
        byTool: [{ ...unknown, toolName: "unobserved", inputLength: { ...base.modelRequests.durationMs, coverage: "unavailable" },
          outputLength: { ...base.modelRequests.durationMs, coverage: "unavailable" } }],
      },
    });
    const view = await render(<ResourceMetrics statistics={statistics} />);
    try {
      const requests = [...view.container.querySelectorAll('table[aria-label="操作次数"] tbody tr')]
        .find((row) => row.querySelector("th")?.textContent === "模型请求")!;
      expect([...requests.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(Array(6).fill("未获得"));
      const tools = view.container.querySelector('table[aria-label="工具调用明细"] tbody tr')!;
      expect([...tools.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(Array(6).fill("未获得"));
      expect(view.container.textContent).toContain("原生生成任务 未获得 个");
      expect(view.container.textContent).toContain("模型重试 未获得 次");
    } finally { await view.unmount(); }
  });
  it("keeps the Agent stage status separate from telemetry operation outcomes", async () => {
    const summary = metricSummary(resourceStatistics(), resourceStatistics()).execution;
    expect(stageStatusFor(summary)).toBe("succeeded");
    expect(stageStatusFor({ ...summary, records: 2, statuses: { ...summary.statuses, running: 1 } })).toBeUndefined();
    const view = await render(<ResourceMetrics statistics={fixture()} stageStatus="succeeded" />);
    try {
      expect(view.container.textContent).toContain("阶段状态");
      expect(view.container.textContent).toContain("成功");
      expect(view.container.textContent).toContain("未闭合");
    } finally { await view.unmount(); }
  });

  it("shows operation outcomes, turn labels and per-tool details in the operation panel", async () => {
    const view = await render(<ResourceMetrics statistics={fixture()} />);
    try {
      const operations = view.container.querySelector('table[aria-label="操作次数"]')!;
      expect([...operations.querySelectorAll("tbody th")].map((item) => item.textContent)).toEqual(["处理轮（Turn）", "思考步骤", "内容步骤", "模型请求", "延迟轮询", "压缩请求", "工具调用"]);
      expect(view.container.textContent).toContain("模型重试 0 次，压缩重试 0 次");
      const turns = operations.querySelector("tbody tr")!;
      expect([...turns.querySelectorAll("td")].slice(0, 6).map((item) => item.textContent)).toEqual(["4", "2", "1", "未获得", "未获得", "1"]);
      const thinking = [...operations.querySelectorAll("tbody tr")].find((row) => row.querySelector("th")?.textContent === "思考步骤")!;
      expect([...thinking.querySelectorAll("td")].map((item) => item.textContent)).toEqual(["2", "1", "1", "未获得", "未获得", "未获得"]);
      const tool = view.container.querySelector('table[aria-label="工具调用明细"] tbody tr')!;
      expect(tool.textContent).toContain("write_file");
      expect(view.container.querySelector('table[aria-label="工具长度与耗时分布"]')).not.toBeNull();
      expect(view.container.querySelector('[aria-label="费用"]')).toBeNull();
      expect(view.container.querySelector('[aria-label="Token 与缓存"]')).toBeNull();
      expect(view.container.textContent).toContain("资源完整性");
      expect([...view.container.querySelectorAll("span")].filter((item) => item.textContent === "完整")).toHaveLength(1);
      expect(view.container.textContent).toContain("未关联到处理轮的工具 1 次、模型请求 2 次");
    } finally { await view.unmount(); }
  });

  it("keeps selected-tool status, size and duration details in the operation panel", async () => {
    const statistics = fixture();
    const distribution = aggregatedResourceStatistics(statistics).distribution;
    const view = await render(<ResourceMetrics statistics={statistics} distribution={distribution} />);
    try {
      const status = view.container.querySelector('table[aria-label="工具 write_file 明细"]')!;
      const text = view.container.textContent!;
      expect(text.indexOf("操作次数")).toBeLessThan(text.indexOf("按工具查看"));
      expect(status.querySelectorAll("tbody tr")).toHaveLength(9);
      expect(status.textContent).toContain("成功");
      const row = (label: string) => [...status.querySelectorAll("tbody tr")].find((item) => item.querySelector("th > span")?.textContent === label)!;
      expect([...row("请求大小").querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["160 B", "180 B", "100 B — 200 B", "43.2049 B", "3", "0"]);
      expect([...row("返回大小").querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["未获得", "未获得", "未获得 — 未获得", "未获得", "0", "3"]);
      expect([...row("调用耗时").querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["200 毫秒", "200 毫秒", "100 毫秒 — 300 毫秒", "81.6497 毫秒", "3", "0"]);
    } finally { await view.unmount(); }
  });

  it("puts product-facing evaluation conclusions before technical details", async () => {
    const outputs: EvaluationOutputSummary = {
      ...metricSummary(resourceStatistics(), resourceStatistics()).evaluationOutputs,
      evaluations: 16,
      validation: { valid: 16, invalid: 0, unavailable: 0 },
      fields: [
        {
          jsonPointer: "/quality", title: "页面质量", description: "依据交付物的完整度与可用性评分", kinds: ["number"],
          observationCount: 16, contributingEvaluationCount: 16, missingEvaluationCount: 0,
          numeric: { count: 16, missing: 0, total: 1328, min: 70.55, max: 95.45, mean: 83, variance: 58.5565, median: 83 },
          distribution: [], coverage: "complete", diagnostics: [],
        },
        {
          jsonPointer: "/passed", title: "任务完成", description: "产物是否满足任务的主要要求", kinds: ["boolean"],
          observationCount: 16, contributingEvaluationCount: 16, missingEvaluationCount: 0, numeric: null,
          distribution: [{ value: true, count: 15, share: 15 / 16, evaluations: 15 }, { value: false, count: 1, share: 1 / 16, evaluations: 1 }],
          coverage: "complete", nullCount: 0, diagnostics: [],
        },
      ],
    };
    const view = await render(<OutputFields outputs={outputs} />);
    try {
      const text = view.container.textContent!;
      expect(text).toContain("评估指标概览");
      expect(text).toContain("有效结果");
      expect(text).toContain("93.8%");
      expect(text).toContain("页面质量");
      expect(text).toContain("任务完成");
      expect(text).toContain("83");
      expect(text).toContain("是");
      expect(text).not.toContain("有效样本 N");
      expect(text).not.toContain("覆盖全部有效评估");
      expect([...view.container.querySelectorAll("details")].every((details) => !details.open)).toBe(true);
    } finally { await view.unmount(); }
  });

  it("keeps field-level missing counts out of evaluation result cards", async () => {
    const outputs: EvaluationOutputSummary = {
      ...metricSummary(resourceStatistics(), resourceStatistics()).evaluationOutputs,
      evaluations: 4,
      validation: { valid: 4, invalid: 0, unavailable: 0 },
      fields: [{
        jsonPointer: "/quality", title: "页面质量", description: "", kinds: ["number"],
        observationCount: 3, contributingEvaluationCount: 3, missingEvaluationCount: 4,
        numeric: { count: 3, missing: 0, total: 240, min: 70, max: 90, mean: 80, variance: 100, median: 80 },
        distribution: [], coverage: "partial", diagnostics: [],
      }],
    };
    const view = await render(<OutputFields outputs={outputs} />);
    try {
      expect(view.container.textContent).not.toContain("缺失 4");
      expect(view.container.textContent).not.toContain("缺4");
    } finally { await view.unmount(); }
  });

  it("uses the same categories for each Agent and the four-level summary, with separate roles", async () => {
    const execution = fixture();
    const evaluation = resourceStatistics();
    const view = await render(<>
      <SummaryCards summary={metricSummary(execution, evaluation)} />
      <AgentPanel projectId="project" title="执行 Agent" agent={agentMetric(execution)} />
    </>);
    try {
      const tables = [...view.container.querySelectorAll('table[aria-label="工具调用明细"]')];
      expect(tables).toHaveLength(3);
      expect(tables[0]?.textContent).toContain("write_file");
      expect(tables[1]?.textContent).toContain("暂无工具调用");
      expect(tables[2]?.textContent).toContain("write_file");
    } finally { await view.unmount(); }
  });

  it("counts only active stage statuses as in progress", async () => {
    const base = metricSummary(resourceStatistics(), resourceStatistics());
    const summary = {
      ...base,
      execution: {
        ...base.execution,
        records: 13,
        terminalRecords: 0,
        statuses: { queued: 8, starting: 2, running: 3, retrying: 0, succeeded: 0, failed: 0, cancelled: 0 },
      },
      evaluation: {
        ...base.evaluation,
        records: 13,
        terminalRecords: 0,
        statuses: { queued: 8, starting: 2, running: 3, retrying: 0, succeeded: 0, failed: 0, cancelled: 0 },
      },
    };
    const view = await render(<SummaryCards summary={summary} />);
    try {
      expect(view.container.textContent).toContain("执行中 5");
      expect(view.container.textContent).not.toContain("执行中 13");
      expect(view.container.textContent).toContain("评估中 5");
      expect(view.container.textContent).not.toContain("评估中 13");
    } finally { await view.unmount(); }
  });

  it("puts output details before drill-down results and collapsed resource statistics", async () => {
    const summary = metricSummary(fixture(), resourceStatistics());
    const view = await render(<SummaryCards summary={summary}><h2>下一级实验结果</h2></SummaryCards>);
    try {
      const text = view.container.textContent!;
      expect(text).toContain("下一级实验结果");
      expect(text.indexOf("评估指标概览")).toBeLessThan(text.indexOf("下一级实验结果"));
      expect(text.indexOf("下一级实验结果")).toBeLessThan(text.indexOf("执行 Agent 资源与轨迹"));
      const resources = [...view.container.querySelectorAll("details")].find((item) => item.querySelector("summary")?.textContent?.includes("资源与轨迹统计"));
      expect(resources).toBeDefined();
      expect(resources?.open).toBe(false);
      expect(resources?.textContent).toContain("write_file");
      expect(resources?.textContent).toContain("评估 Agent 资源与轨迹");
      expect(resources?.textContent).toContain("模型 未获得");
      expect(resources?.textContent).toContain("缓存命中率");
      expect(resources?.textContent).toContain("41.2%");
    } finally { await view.unmount(); }
  });

  it("explains failed, unfinalized and pending resource collection instead of only 未获得", async () => {
    const statistics = resourceStatistics({ coverage: "partial", collections: { collected: 3, pending: 0, failed: 2, uncollected: 0, unsubmitted: 0, finalized: 1 } });
    const view = await render(<ResourceMetrics statistics={statistics} resourcesPending />);
    try {
      const notes = view.container.querySelector('[data-testid="resource-collection-notes"]')!;
      expect([...notes.children].map((item) => item.textContent)).toEqual(["补采资源中", "资源采集失败 2 个", "2 个资源快照未定稿，数值可能不完整"]);
    } finally { await view.unmount(); }
  });

  it("shows no collection notes for complete resources and keeps them in the summary header", async () => {
    const complete = await render(<ResourceMetrics statistics={resourceStatistics()} />);
    try { expect(complete.container.querySelector('[data-testid="resource-collection-notes"]')).toBeNull(); }
    finally { await complete.unmount(); }
    const partial = resourceStatistics({ collections: { collected: 1, pending: 2, failed: 0, uncollected: 1, unsubmitted: 0, finalized: 0 } });
    const view = await render(<SummaryCards summary={metricSummary(partial, resourceStatistics())} />);
    try {
      const notes = view.container.querySelectorAll('[data-testid="resource-collection-notes"]');
      expect(notes[0]?.closest("button")).not.toBeNull();
      expect([...notes[0]!.children].map((item) => item.textContent)).toEqual(["补采资源中 2 个", "1 个资源尚未采集", "1 个资源快照未定稿，数值可能不完整"]);
    } finally { await view.unmount(); }
  });

  it("shows the Agent stage hint and resource retry in the Agent panel", async () => {
    const agent = { ...agentMetric(resourceStatistics()), stage: { status: "succeeded", resourcesPending: { deadline: "2026-01-01T00:10:00.000Z" } } } as Parameters<typeof AgentPanel>[0]["agent"];
    const view = await render(<AgentPanel projectId="project" title="执行 Agent" agent={agent} />);
    try {
      expect(view.container.querySelector('[data-testid="stage-hint"]')?.textContent).toBe("补采资源中");
      expect(view.container.querySelector('[data-testid="resource-collection-notes"]')?.textContent).toContain("补采资源中");
    } finally { await view.unmount(); }
  });
});
