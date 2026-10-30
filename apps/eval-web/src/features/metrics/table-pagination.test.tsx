import { expect, it } from "vitest";
import { click, render } from "@/test/render";
import { resourceStatistics } from "@/test/metrics";
import { ResourceMetrics } from "./resource-metrics";
import { StatisticsTable } from "./statistics-table";
import { ToolStatisticsTable } from "./tool-statistics-table";

const numeric = { count: 1, missing: 0, total: 10, min: 10, max: 10, mean: 10, variance: 0, median: 10 };

it("pages numeric statistics without changing their measurements", async () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({ label: `指标 ${index}`, unit: "次", summary: numeric }));
  const view = await render(<StatisticsTable label="统计测试" description="统计值保持不变" rows={rows} />);
  try {
    expect(view.container.querySelectorAll("tbody tr")).toHaveLength(20);
    await click([...view.container.querySelectorAll("nav button")].find((button) => button.textContent === "下一页"));
    expect(view.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(view.container.querySelector("tbody th")?.textContent).toBe("指标 20次");
    expect(view.container.querySelector("tbody td")?.textContent).toBe("10");
  } finally { await view.unmount(); }
});

it.each(["overview", "operations"] as const)("pages tool statistics in the %s view", async (variant) => {
  const { tools: operation, toolSuccessRate } = resourceStatistics().trajectory;
  const tools = Array.from({ length: 41 }, (_, index) => ({
    ...operation, toolName: `tool-${index}`, toolSuccessRate,
    inputLength: { ...numeric, coverage: "complete" as const },
    outputLength: { ...numeric, coverage: "complete" as const },
  }));
  const view = await render(<ToolStatisticsTable tools={tools} variant={variant} />);
  const next = () => [...view.container.querySelectorAll("nav button")].find((button) => button.textContent === "下一页");
  try {
    expect(view.container.querySelectorAll("tbody tr")).toHaveLength(20);
    await click(next());
    expect(view.container.querySelector("tbody th")?.textContent).toBe("tool-20");
    await click(next());
    expect(view.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(next()).toHaveProperty("disabled", true);
  } finally { await view.unmount(); }
});

it("includes pagination for the operation-count table even when it fits on one page", async () => {
  const view = await render(<ResourceMetrics statistics={resourceStatistics()} />);
  try {
    const navigation = view.container.querySelector('nav[aria-label="操作次数分页"]');
    expect(navigation?.textContent).toContain("每页 20 条");
    expect([...navigation!.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  } finally { await view.unmount(); }
});
