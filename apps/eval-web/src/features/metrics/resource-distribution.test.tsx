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
  const view = await render(<SummaryCards summary={{ ...summary, executionAgent: { ...base, coverage: "partial", distribution } }} />);
  try {
    await click(view.container.querySelector("details > summary"));
    const agents = [...view.container.querySelectorAll<HTMLButtonElement>('[data-slot="accordion-trigger"]')];
    expect(agents.map((button) => button.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    expect(agents[0]?.textContent).toContain("资源完整性");
    expect(agents[0]?.textContent).toContain("部分");
    expect(view.container.querySelector('table[aria-label="Agent Token 与缓存分布"]')).toBeNull();
    await click(agents[0]);
    expect(agents.map((button) => button.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
    await click([...view.container.querySelectorAll('[role="tab"]')].find((item) => item.textContent === "分布统计"));
    const table = view.container.querySelector('table[aria-label="Agent Token 与缓存分布"]')!;
    const cells = (label: string) => [...[...table.querySelectorAll("tbody tr")].find((row) => row.querySelector("th > span")?.textContent === label)!.querySelectorAll("td")].map((cell) => cell.textContent);
    expect(cells("缓存读取 Token")).toEqual(["0.0015", "0.0015", "0.001 — 0.002", "2", "2"]);
    expect(table.querySelector("thead")?.textContent).not.toContain("总体方差");
    const variance = table.closest("section")!.querySelector("button");
    await click(variance);
    expect(variance?.getAttribute("aria-pressed")).toBe("true");
    expect(cells("缓存读取 Token")).toEqual(["0.0015", "0.0015", "0.001 — 0.002", "2.5E-7Token²", "2", "2"]);
    expect(cells("推理 Token")).toEqual(["未获得", "未获得", "未获得 — 未获得", "未获得", "0", "4"]);
    expect(table.textContent).not.toMatch(/完整性|完整|部分|无结果/u);
    expect(table.textContent).toContain("总体方差和中位数只统计有效 N");
    await click(agents[1]);
    expect(agents.map((button) => button.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    await click(agents[0]);
    expect(agents.map((button) => button.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    await click(agents[0]);
    expect(variance?.getAttribute("aria-pressed")).toBe("true");
    await click(variance);
    expect(cells("缓存读取 Token")).toEqual(["0.0015", "0.0015", "0.001 — 0.002", "2", "2"]);
  } finally { await view.unmount(); }
});
