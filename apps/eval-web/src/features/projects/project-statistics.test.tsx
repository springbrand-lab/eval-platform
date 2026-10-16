import { expect, it } from "vitest";
import { render } from "@/test/render";
import { metricSummary, resourceStatistics } from "@/test/metrics";
import { ProjectStatistics } from "./project-statistics";

it("keeps both Agents' totals, distributions and duration tables visible without tabs or collapsed sections", async () => {
  const summary = metricSummary(resourceStatistics(), resourceStatistics());
  const screen = await render(<ProjectStatistics summary={summary} />);
  try {
    expect(screen.container.querySelector('[role="tablist"]')).toBeNull();
    expect(screen.container.querySelector('details:not([open]), [aria-expanded="false"]')).toBeNull();
    for (const role of ['执行 Agent', '评估 Agent']) {
      const region = screen.container.querySelector(`[aria-label="${role}完整资源统计"]`)!;
      expect(region.textContent).toContain('实际积分');
      expect(region.textContent).toContain('总 Token');
      for (const label of ['轨迹操作', 'Agent 与尝试耗时', 'Agent Token 与缓存分布', 'Agent 积分与成本分布', 'Agent 轨迹次数分布']) {
        expect(region.querySelector(`table[aria-label="${label}"]`)).not.toBeNull();
      }
    }
  } finally { await screen.unmount(); }
});
