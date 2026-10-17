import { describe, expect, it } from "vitest";
import { render } from "@/test/render";
import { aggregatedResourceStatistics, agentMetric, metricSummary, resourceStatistics } from "@/test/metrics";
import { AgentPanel } from "@/features/results/agent-panel";
import { ResourceMetrics } from "./resource-metrics";
import { SummaryCards } from "./summary";

function fixture() {
  const base = resourceStatistics();
  return resourceStatistics({ trajectory: {
    ...base.trajectory, coverage: "partial",
    turns: { ...base.trajectory.turns, count: { value: 4, coverage: "partial" }, completed: 2, failed: 1, unknown: 1 },
    tools: { ...base.trajectory.tools, count: { value: 3, coverage: "partial" }, completed: 2, failed: 1 },
    thinkingTurns: { value: 2, coverage: "partial" },
    thinkingTurnOperations: { ...base.trajectory.thinkingTurnOperations, count: { value: 2, coverage: "partial" }, completed: 1, failed: 1 },
    contentTurns: { value: 1, coverage: "partial" },
    contentTurnOperations: { ...base.trajectory.contentTurnOperations, count: { value: 1, coverage: "partial" }, completed: 1 },
    thinkingTurnTokens: { input: { value: 160, coverage: "partial" }, output: { value: 40, coverage: "partial" }, total: { value: 200, coverage: "partial" } },
    contentTurnTokens: { input: { value: 80, coverage: "partial" }, output: { value: null, coverage: "unavailable" }, total: { value: null, coverage: "unavailable" } },
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
  it("shows operation outcomes, turn labels and per-tool details in the operation panel", async () => {
    const view = await render(<ResourceMetrics statistics={fixture()} />);
    try {
      const operations = view.container.querySelector('table[aria-label="操作次数"]')!;
      expect([...operations.querySelectorAll("tbody th")].map((item) => item.textContent)).toEqual(["处理轮（Turn）", "思考命中轮", "内容命中轮", "模型请求", "工具调用"]);
      const turns = operations.querySelector("tbody tr")!;
      expect([...turns.querySelectorAll("td")].slice(0, 6).map((item) => item.textContent)).toEqual(["4", "2", "1", "0", "0", "1"]);
      const thinking = [...operations.querySelectorAll("tbody tr")].find((row) => row.querySelector("th")?.textContent === "思考命中轮")!;
      expect([...thinking.querySelectorAll("td")].map((item) => item.textContent)).toEqual(["2", "1", "1", "0", "0", "0"]);
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

  it("uses the same categories for each Agent and the four-level summary, with separate roles", async () => {
    const execution = fixture();
    const evaluation = resourceStatistics();
    const view = await render(<>
      <SummaryCards summary={metricSummary(execution, evaluation)} />
      <AgentPanel title="执行 Agent" agent={agentMetric(execution)} />
    </>);
    try {
      const tables = [...view.container.querySelectorAll('table[aria-label="工具调用明细"]')];
      expect(tables).toHaveLength(3);
      expect(tables[0]?.textContent).toContain("write_file");
      expect(tables[1]?.textContent).toContain("暂无工具调用");
      expect(tables[2]?.textContent).toContain("write_file");
    } finally { await view.unmount(); }
  });

  it("puts output details before drill-down results and collapsed resource statistics", async () => {
    const summary = metricSummary(fixture(), resourceStatistics());
    const view = await render(<SummaryCards summary={summary}><h2>下一级实验结果</h2></SummaryCards>);
    try {
      const text = view.container.textContent!;
      expect(text).toContain("下一级实验结果");
      expect(text.indexOf("评估指标统计")).toBeLessThan(text.indexOf("下一级实验结果"));
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
});
