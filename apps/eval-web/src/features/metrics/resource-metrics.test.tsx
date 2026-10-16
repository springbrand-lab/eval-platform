import { describe, expect, it } from "vitest";
import { click, render } from "@/test/render";
import { agentMetric, metricSummary, resourceStatistics } from "@/test/metrics";
import { AgentPanel } from "@/features/results/agent-panel";
import { ResourceMetrics } from "./resource-metrics";
import { SummaryCards } from "./summary";

function fixture() {
  const base = resourceStatistics();
  return resourceStatistics({ trajectory: {
    ...base.trajectory, coverage: "partial",
    turns: { ...base.trajectory.turns, count: { value: 4, coverage: "partial" }, completed: 2, failed: 1, unknown: 1 },
    tools: { ...base.trajectory.tools, count: { value: 3, coverage: "partial" }, completed: 2, failed: 1 },
    nonToolTurns: { value: 1, coverage: "partial" },
    nonToolTurnTokens: { input: { value: 80, coverage: "partial" }, output: { value: null, coverage: "unavailable" }, total: { value: null, coverage: "unavailable" } },
    byTool: [{
      ...base.trajectory.tools, toolName: "write_file", count: { value: 3, coverage: "partial" }, completed: 2, failed: 1,
      inputLength: { count: 3, missing: 0, total: 480, min: 100, max: 200, mean: 160, variance: 1866.6666666666667, median: 180, coverage: "partial" },
      outputLength: { count: 0, missing: 3, total: null, min: null, max: null, mean: null, variance: null, median: null, coverage: "unavailable" },
    }],
    unlinkedOperations: { tools: 1, generations: 2 },
  } });
}

describe("Agent resource and trajectory categories", () => {
  it("shows operation outcomes, per-tool byte lengths, non-tool turns and missing tokens without inferring them", async () => {
    const view = await render(<ResourceMetrics statistics={fixture()} />);
    try {
      const operations = view.container.querySelector('table[aria-label="轨迹操作"]')!;
      expect([...operations.querySelectorAll("tbody th")].map((item) => item.textContent)).toEqual(["轨迹轮数", "工具调用", "模型请求"]);
      const turns = operations.querySelector("tbody tr")!;
      expect([...turns.querySelectorAll("td")].slice(0, 6).map((item) => item.textContent)).toEqual(["4", "2", "1", "0", "0", "1"]);
      const tool = view.container.querySelector('table[aria-label="工具类型统计"] tbody tr')!;
      expect(tool.textContent).toContain("write_file");
      await click([...view.container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("工具长度与耗时")));
      const lengths = view.container.querySelector('table[aria-label="工具长度与耗时分布"]')!;
      const rows = [...lengths.querySelectorAll("tbody tr")];
      expect([...rows[0]!.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["480 B", "160 B", "180 B", "100 B — 200 B", "3", "0"]);
      expect([...rows[1]!.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["未获得", "未获得", "未获得", "未获得 — 未获得", "0", "3"]);
      await click(lengths.closest("section")!.querySelector("button"));
      expect(rows[0]!.textContent).toContain("1,866.67字节²");
      const details = [...view.container.querySelectorAll("dt")];
      const value = (label: string) => details.find((item) => item.textContent === label)?.nextElementSibling?.textContent;
      expect(value("非工具轮数")).toBe("1");
      expect(value("非工具轮输入 Token")).toBe("80");
      expect(value("非工具轮总 Token")).toBe("未获得");
      expect(value("资源完整性")).toBe("完整");
      expect([...view.container.querySelectorAll("span")].filter((item) => item.textContent === "完整")).toHaveLength(1);
      expect(view.container.textContent).toContain("未关联到轮次的工具 1 次、模型请求 2 次");
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
      const tables = [...view.container.querySelectorAll('table[aria-label="工具类型统计"]')];
      expect(tables).toHaveLength(3);
      expect(tables[0]?.textContent).toContain("write_file");
      expect(tables[1]?.textContent).toContain("暂无工具类型数据");
      expect(tables[2]?.textContent).toContain("write_file");
    } finally { await view.unmount(); }
  });

  it("puts drill-down results before output details and collapsed resource statistics", async () => {
    const summary = metricSummary(fixture(), resourceStatistics());
    const view = await render(<SummaryCards summary={summary}><h2>下一级实验结果</h2></SummaryCards>);
    try {
      const text = view.container.textContent!;
      expect(text).toContain("下一级实验结果");
      expect(text.indexOf("下一级实验结果")).toBeLessThan(text.indexOf("Schema 评估输出"));
      expect(text.indexOf("Schema 评估输出")).toBeLessThan(text.indexOf("执行 Agent 资源与轨迹"));
      const resources = [...view.container.querySelectorAll("details")].find((item) => item.querySelector("summary")?.textContent?.includes("资源与轨迹统计"));
      expect(resources).toBeDefined();
      expect(resources?.open).toBe(false);
      expect(resources?.textContent).toContain("write_file");
      expect(resources?.textContent).toContain("评估 Agent 资源与轨迹");
    } finally { await view.unmount(); }
  });
});
