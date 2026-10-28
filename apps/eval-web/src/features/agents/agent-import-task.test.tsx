import type { AgentImportTaskView } from "@eval-platform/eval-contracts";
import { expect, it } from "vitest";
import { click, render } from "@/test/render";
import { AgentImportTask } from "./agent-import-task";

it("pages per-Agent import results while keeping the complete task counts", async () => {
  const task: AgentImportTaskView = {
    id: "task", sourceUserId: "source", purpose: "execution", status: "completed",
    agents: Array.from({ length: 23 }, (_, index) => ({
      id: `agent-${index}`, name: `Agent ${index}`, status: "created", skillCount: 1, referenceCount: 0,
    })),
    progress: { stage: "completed", completed: 23, total: 23, bytesRead: 100, totalBytes: 100 },
    summary: { created: 23, skipped: 0, failed: 0, conflicts: 0 },
  };
  const view = await render(<AgentImportTask task={task} userName="来源用户" expired={false} />);
  try {
    expect(view.container.querySelectorAll("tbody tr")).toHaveLength(20);
    await click([...view.container.querySelectorAll("nav button")].find((button) => button.textContent === "下一页"));
    expect(view.container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(view.container.querySelector("tbody tr")?.textContent).toContain("Agent 20");
    expect(view.container.querySelector('[aria-label="导入数量"]')?.textContent).toContain("所选 Agent 23");
  } finally { await view.unmount(); }
});
