import { describe, expect, it } from "vitest";
import type { ComparisonResources } from "@/api-sdk/types";
import { ComparisonSummary } from "@/features/dashboard/comparison-summary";
import { comparisonView } from "@/test/comparison";
import { render } from "@/test/render";
import { comparisonExecutionMetrics, ExecutionMetrics } from "./execution-metrics";

function displayedValues(container: Element) {
  const metrics = container.querySelector('dl[aria-label="执行 Agent 指标"]')!;
  return Object.fromEntries([...metrics.querySelectorAll("dt")].map((term) => [
    term.textContent, term.nextElementSibling?.textContent,
  ]));
}

describe("execution Agent measurements", () => {
  it.each([false, true])("shows the canonical aggregate means and rates without disclosure controls (compact: %s)", async (compact) => {
    const base = comparisonView().summary[0]!.resources;
    const resources: ComparisonResources = {
      chargedUnits: { value: 7.5, coverage: "partial" },
      chargedUnitsPerAgent: {
        ...base.chargedUnitsPerAgent, count: 3, missing: 1, mean: 2.5, total: 7.5, coverage: "partial",
        min: 2.5, max: 2.5, median: 2.5, variance: 0,
      },
      agentDurationMs: {
        ...base.agentDurationMs, count: 3, missing: 1, mean: 1_234, total: 3_702,
        min: 1_234, max: 1_234, median: 1_234, variance: 0,
      },
      cacheHitRate: { value: 0.25, coverage: "complete" },
      toolSuccessRate: { value: 0.9, coverage: "partial" },
    };
    const view = await render(<ExecutionMetrics value={comparisonExecutionMetrics(resources)} average compact={compact} />);
    try {
      expect(displayedValues(view.container)).toEqual({
        "平均执行积分": "2.5 · 部分",
        "平均执行耗时": "1.2 秒 · 部分",
        "缓存命中率": "25.0%",
        "工具调用成功率": "90.0% · 部分",
      });
      expect(view.container.querySelector("details")).toBeNull();
    } finally { await view.unmount(); }
  });

  it("retains actual zero values for all four measurements", async () => {
    const view = await render(<ExecutionMetrics value={{
      chargedUnits: { value: 0, coverage: "complete" },
      durationMs: 0,
      cacheHitRate: { value: 0, coverage: "complete" },
      toolSuccessRate: { value: 0, coverage: "complete" },
    }} />);
    try {
      expect(displayedValues(view.container)).toEqual({
        "实际执行积分": "0", "实际执行耗时": "0 毫秒", "缓存命中率": "0%", "工具调用成功率": "0%",
      });
      expect(view.container.textContent).not.toContain("平均");
    } finally { await view.unmount(); }
  });

  it("distinguishes unavailable measurements from a fully observed rate with no denominator", async () => {
    const view = await render(<ExecutionMetrics value={{
      chargedUnits: { value: null, coverage: "unavailable" },
      durationMs: null,
      cacheHitRate: { value: null, coverage: "unavailable" },
      toolSuccessRate: { value: null, coverage: "complete" },
    }} />);
    try {
      expect(displayedValues(view.container)).toEqual({
        "实际执行积分": "未获得", "实际执行耗时": "未获得", "缓存命中率": "未获得", "工具调用成功率": "—",
      });
      expect(view.container.querySelector('[title="当前范围没有可计算此比率的观察"]')?.textContent).toBe("—");
    } finally { await view.unmount(); }
  });

  it("keeps partial observed zeros and does not claim a partially missing rate is inapplicable", async () => {
    const view = await render(<ExecutionMetrics value={{
      chargedUnits: { value: 0, coverage: "partial" },
      durationMs: 0,
      durationPartial: true,
      cacheHitRate: { value: 0, coverage: "partial" },
      toolSuccessRate: { value: null, coverage: "partial" },
    }} />);
    try {
      expect(displayedValues(view.container)).toEqual({
        "实际执行积分": "0 · 部分", "实际执行耗时": "0 毫秒 · 部分", "缓存命中率": "0% · 部分", "工具调用成功率": "未获得",
      });
      expect(view.container.querySelector("[title]")).toBeNull();
    } finally { await view.unmount(); }
  });

  it.each(["complete", "partial", "unavailable"] as const)("keeps %s charge coverage distinct in overview distribution details", async (coverage) => {
    const comparison = comparisonView();
    const available = coverage !== "unavailable";
    const values = comparison.summary.map((value) => ({
      ...value,
      resources: {
        ...value.resources,
        chargedUnitsPerAgent: {
          ...value.resources.chargedUnitsPerAgent,
          count: available ? 2 : 0, missing: coverage === "complete" ? 0 : 2,
          mean: available ? 0 : null, total: available ? 0 : null,
          min: available ? 0 : null, max: available ? 0 : null, median: available ? 0 : null,
          variance: available ? 0 : null, coverage,
        },
      },
    }));
    const view = await render(<ComparisonSummary projects={comparison.projects} values={values} title="整体表现" scope="全部共同数据" onRemove={() => {}} viewMode="execution" />);
    try {
      const section = view.container.querySelector('section[aria-label="项目 1 表现"]')!;
      const term = [...section.querySelectorAll("details dt")].find((item) => item.textContent?.startsWith("单 Agent 积分分布"))!;
      expect(term.textContent).toBe(`单 Agent 积分分布${coverage === "partial" ? " · 部分" : ""}`);
      expect(displayedValues(section)["平均执行积分"]).toBe(available ? `0${coverage === "partial" ? " · 部分" : ""}` : "未获得");
      expect(term.nextElementSibling?.textContent).toContain(available ? "均值 0" : "均值 未获得");
    } finally { await view.unmount(); }
  });
});
