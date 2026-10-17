import { describe, expect, it } from "vitest";
import { render } from "@/test/render";
import { agentMetric, resourceStatistics } from "@/test/metrics";
import { TokenMetrics } from "./token-metrics";

describe("Token and cache display", () => {
  it("shows one set of token values and cache hit rate, preserving zero and missing values", async () => {
    const tokens = {
      ...resourceStatistics().tokens,
      cacheRead: { value: 0, coverage: "complete" as const },
      cacheWrite: { value: null, coverage: "unavailable" as const },
    };
    const view = await render(<TokenMetrics statistics={resourceStatistics({ tokens, cacheHitRate: { value: 0.25, coverage: "partial" }, byModel: [{
      provider: "provider", model: "model", usageRecords: 1, providerUsd: { value: null, coverage: "unavailable" },
      tokens: { ...tokens, cacheRead: { value: 41, coverage: "partial" } },
    }] })} />);
    try {
      expect([...view.container.querySelectorAll("dd")].map((cell) => cell.textContent)).toEqual(["200", "0", "未获得", "100", "20", "5", "25.0%"]);
      expect(view.container.textContent).toContain("模型 model");
      expect(view.container.textContent).not.toMatch(/全部模型|完整|部分|无结果/u);
      expect(view.container.querySelector("table")).toBeNull();
    } finally { await view.unmount(); }
  });

  it("keeps execution and evaluation caches separate in the shared four-level summary", async () => {
    const execution = resourceStatistics();
    const evaluation = resourceStatistics({ tokens: { ...execution.tokens, cacheRead: { value: 13, coverage: "partial" } }, cacheHitRate: { value: 13 / 113, coverage: "partial" } });
    const view = await render(<>
      <TokenMetrics statistics={execution} />
      <TokenMetrics statistics={evaluation} />
    </>);
    try {
      const sections = [...view.container.querySelectorAll('section[aria-label="Token 与缓存"]')];
      expect(sections).toHaveLength(2);
      const cacheRead = (section: Element) => [...section.querySelectorAll("dt")].find((label) => label.textContent === "缓存读取 Token")?.nextElementSibling?.textContent;
      expect(cacheRead(sections[0]!)).toBe("70");
      expect(cacheRead(sections[1]!)).toBe("13");
      // Both totals use the API's 200, never adding cache or reasoning again.
      for (const section of sections) expect(section.querySelector("dd")?.textContent).toBe("200");
    } finally { await view.unmount(); }
  });

  it("renders the same cache breakdown on an individual Agent", async () => {
    const view = await render(<TokenMetrics statistics={agentMetric(resourceStatistics()).resources} />);
    try {
      const section = view.container.querySelector('section[aria-label="Token 与缓存"]')!;
      const value = (name: string) => [...section.querySelectorAll("dt")].find((label) => label.textContent === name)?.nextElementSibling?.textContent;
      expect(value("缓存读取 Token")).toBe("70");
      expect(value("缓存写入 Token")).toBe("10");
      expect(section.textContent).not.toContain("完整");
    } finally { await view.unmount(); }
  });
});
