import { expect, it } from "vitest";
import { aggregatedResourceStatistics, resourceStatistics } from "@/test/metrics";
import { click, render } from "@/test/render";
import { ResourceMetrics } from "./resource-metrics";

it("shows five statistics with each metric's effective N, preserving standard deviation and unavailable values", async () => {
  const base = aggregatedResourceStatistics(resourceStatistics());
  const distribution = { ...base.distribution, records: 4, tokens: {
    ...base.distribution.tokens,
    cacheRead: { count: 2, missing: 2, total: 0.003, min: 0.001, max: 0.002, mean: 0.0015, variance: 0.00000025, median: 0.0015, coverage: "partial" as const },
    reasoning: { count: 0, missing: 4, total: null, min: null, max: null, mean: null, variance: null, median: null, coverage: "unavailable" as const },
  } };
  const view = await render(<ResourceMetrics statistics={{ ...base, coverage: "partial" }} distribution={distribution} />);
  try {
    expect(view.container.textContent).toContain("资源完整性");
    expect(view.container.textContent).toContain("部分");
    await click([...view.container.querySelectorAll('[role="tab"]')].find((item) => item.textContent?.startsWith("Token")));
    const table = view.container.querySelector('table[aria-label="Token 的 Agent 间差异"]')!;
    const cells = (label: string) => [...[...table.querySelectorAll("tbody tr")].find((row) => row.querySelector("th > span")?.textContent === label)!.querySelectorAll("td")].map((cell) => cell.textContent);
    expect(cells("缓存读取 Token")).toEqual(["0.0015", "0.0015", "0.001 — 0.002", "0.0005", "2", "2"]);
    expect(table.querySelector("thead")?.textContent).toContain("标准差");
    expect(table.querySelector("thead")?.textContent).not.toContain("总体方差");
    expect(cells("推理 Token")).toEqual(["未获得", "未获得", "未获得 — 未获得", "未获得", "0", "4"]);
    expect(table.textContent).not.toMatch(/完整性|完整|部分|无结果/u);
    expect(table.textContent).toContain("标准差和中位数只统计有效 N");
    expect(view.container.querySelector('[role="tabpanel"]')?.textContent).toContain("缓存命中率");
  } finally { await view.unmount(); }
});
