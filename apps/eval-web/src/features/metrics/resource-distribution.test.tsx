import { expect, it } from "vitest";
import { aggregatedResourceStatistics, metricSummary, resourceStatistics } from "@/test/metrics";
import { click, render } from "@/test/render";
import { SummaryCards } from "./summary";

it("shows five statistics with each metric's effective N, preserving small nonzero variance and unavailable values", async () => {
  const base = aggregatedResourceStatistics(resourceStatistics());
  const summary = metricSummary(base, resourceStatistics());
  const distribution = { ...base.distribution, records: 4, tokens: {
    ...base.distribution.tokens,
    cacheRead: { count: 2, missing: 2, total: 0.003, min: 0.001, max: 0.002, mean: 0.0015, variance: 0.00000025, median: 0.0015, coverage: "partial" as const },
    reasoning: { count: 0, missing: 4, total: null, min: null, max: null, mean: null, variance: null, median: null, coverage: "unavailable" as const },
  } };
  const view = await render(<SummaryCards summary={{ ...summary, executionAgent: { ...base, distribution } }} />);
  try {
    await click([...view.container.querySelectorAll("button")].find((item) => item.textContent === "均值、方差、中位数与范围"));
    const table = view.container.querySelector('table[aria-label="Agent Token 与缓存分布"]')!;
    const cells = (label: string) => [...[...table.querySelectorAll("tbody tr")].find((row) => row.querySelector("th")?.textContent === label)!.querySelectorAll("td")].map((cell) => cell.textContent);
    expect(cells("缓存读取 Token")).toEqual(["Token", "0.0015", "2.5E-7", "0.0015", "0.001", "0.002", "2", "2"]);
    expect(cells("推理 Token")).toEqual(["Token", "未获得", "未获得", "未获得", "未获得", "未获得", "0", "4"]);
    expect(table.textContent).not.toMatch(/完整性|完整|部分|无结果/u);
    expect(table.textContent).toContain("总体方差和中位数只统计有效 N");
  } finally { await view.unmount(); }
});
