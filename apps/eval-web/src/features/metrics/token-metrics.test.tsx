import { describe, expect, it } from "vitest";
import { render } from "@/test/render";
import { agentMetric, metricSummary, resourceStatistics } from "@/test/metrics";
import { AgentPanel } from "@/features/results/agent-panel";
import { SummaryCards } from "./summary";
import { TokenMetrics } from "./token-metrics";

describe("Token and cache display", () => {
  it("distinguishes real zero, missing, and partial cache values, including per-model values", async () => {
    const tokens = {
      ...resourceStatistics().tokens,
      cacheRead: { value: 0, coverage: "complete" as const },
      cacheWrite: { value: null, coverage: "unavailable" as const },
    };
    const view = await render(<TokenMetrics statistics={resourceStatistics({ tokens, byModel: [{
      provider: "provider", model: "model", usageRecords: 1, providerUsd: { value: null, coverage: "unavailable" },
      tokens: { ...tokens, cacheRead: { value: 41, coverage: "partial" } },
    }] })} />);
    try {
      const rows = [...view.container.querySelectorAll("tbody tr")];
      const cells = (row: Element) => [...row.querySelectorAll("td")].map((cell) => cell.textContent);
      expect(cells(rows[0]!)).toEqual(["200完整", "0完整", "未获得无结果", "100完整", "20完整", "5完整"]);
      expect(rows[1]?.querySelector("th")?.textContent).toBe("provider / model");
      expect(cells(rows[1]!)[1]).toBe("41部分");
    } finally { await view.unmount(); }
  });

  it("keeps execution and evaluation caches separate in the shared four-level summary", async () => {
    const execution = resourceStatistics();
    const evaluation = resourceStatistics({ tokens: { ...execution.tokens, cacheRead: { value: 13, coverage: "partial" } } });
    const view = await render(<SummaryCards summary={metricSummary(execution, evaluation)} />);
    try {
      const tables = [...view.container.querySelectorAll('table[aria-label="Token 与缓存"]')];
      expect(tables).toHaveLength(2);
      expect(tables[0]?.textContent).toContain("70完整");
      expect(tables[1]?.textContent).toContain("13部分");
      // Both totals use the API's 200, never adding cache or reasoning again.
      for (const table of tables) expect(table.querySelector("tbody td")?.textContent).toBe("200完整");
    } finally { await view.unmount(); }
  });

  it("renders the same cache breakdown on an individual Agent", async () => {
    const view = await render(<AgentPanel title="执行 Agent" agent={agentMetric(resourceStatistics())} />);
    try {
      const table = view.container.querySelector('table[aria-label="Token 与缓存"]');
      expect(table?.textContent).toContain("缓存读取 Token");
      expect(table?.textContent).toContain("70完整");
      expect(table?.textContent).toContain("10完整");
    } finally { await view.unmount(); }
  });
});
