import { expect, it } from "vitest";
import { click, render } from "@/test/render";
import { metricSummary, resourceStatistics } from "@/test/metrics";
import { ProjectStatistics } from "./project-statistics";

it("keeps both Agent summaries and exposes one clear detail category at a time", async () => {
  const summary = metricSummary(resourceStatistics(), resourceStatistics());
  const screen = await render(<ProjectStatistics summary={summary} />);
  try {
    expect(screen.container.querySelectorAll('[role="tablist"]').length).toBeGreaterThan(0);
    expect(screen.container.querySelector('details:not([open])')).toBeNull();
    for (const role of ['执行 Agent', '评估 Agent']) {
      const region = screen.container.querySelector(`[aria-label="${role}完整资源统计"]`)!;
      expect(region.textContent).toContain('实际积分');
      expect(region.textContent).toContain('总 Token');
      expect(region.textContent).toContain('缓存命中率');
      expect(region.textContent).toContain('41.2%');
      expect(region.querySelector(`[aria-label="${role}总览"]`)).not.toBeNull();
      expect(region.querySelector('table[aria-label="工具调用概况"]')).not.toBeNull();
      expect(region.querySelector('table[aria-label="操作次数"]')).not.toBeNull();
      expect(region.querySelector('table[aria-label="Token 的 Agent 间差异"]')).toBeNull();
      await click([...region.querySelectorAll('[role="tab"]')].find((item) => item.textContent?.startsWith('Token')));
      expect(region.querySelector('table[aria-label="Token 的 Agent 间差异"]')).not.toBeNull();
      await click([...region.querySelectorAll('[role="tab"]')].find((item) => item.textContent?.startsWith('耗时')));
      expect(region.querySelector('section[aria-label="耗时明细"]')).not.toBeNull();
      expect(region.querySelector('table[aria-label="Agent 与尝试耗时"]')).not.toBeNull();
    }
  } finally { await screen.unmount(); }
});
