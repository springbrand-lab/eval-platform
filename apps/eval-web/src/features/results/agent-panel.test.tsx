import { expect, it, vi } from "vitest";
import type { AgentMetricView } from "@/api-sdk/types";
import { click, render } from "@/test/render";
import { agentMetric, resourceStatistics } from "@/test/metrics";
import { AgentPanel } from "./agent-panel";

const api = vi.hoisted(() => ({ snapshot: vi.fn(), download: vi.fn() }));
vi.mock("@/api-sdk/observations-api", () => ({ getResourceSnapshot: api.snapshot }));
vi.mock("@/lib/files", () => ({ downloadFile: api.download }));

type AttemptMetric = AgentMetricView["attempts"]["items"][number];

const attempt = (attemptId: string, resourceCollection: AttemptMetric["resourceCollection"]): AttemptMetric => ({
  attemptId, attemptNumber: attemptId === "a-1" ? 1 : 2, status: "completed", submissionId: null,
  startedAt: null, completedAt: null, durationMs: null, error: null, resourceCollection,
});

it.each([[null, "samplings", "sampling"], ["evaluation", "evaluations", "evaluation"]] as const)(
  "downloads a collected Attempt's raw resource snapshot for evaluation %s", async (evaluationId, kind, id) => {
    const snapshot = new Blob(["{}"]);
    api.snapshot.mockResolvedValue(snapshot);
    const agent = { ...agentMetric(resourceStatistics()), evaluationId, attempts: { count: 2, restarts: 1, items: [attempt("a-1", "collected"), attempt("a-2", "failed")] } };
    const view = await render(<AgentPanel projectId="project" title="Agent" agent={agent} />);
    try {
      const buttons = view.container.querySelectorAll('[data-testid="resource-snapshot"]');
      expect(buttons).toHaveLength(1);
      await click(buttons[0]);
      await vi.waitFor(() => expect(api.download).toHaveBeenCalledExactlyOnceWith("resource-snapshot-a-1.json", snapshot, "application/json"));
      expect(api.snapshot).toHaveBeenCalledExactlyOnceWith("project", kind, id, "a-1");
    } finally {
      await view.unmount();
      api.snapshot.mockReset();
      api.download.mockReset();
    }
  },
);
