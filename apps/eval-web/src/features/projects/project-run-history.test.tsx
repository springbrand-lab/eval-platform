import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { metricSummary, resourceStatistics } from "@/test/metrics";
import { click, render } from "@/test/render";
import { ProjectDetailPage } from "./project-detail-page";

const mocks = vi.hoisted(() => ({
  project: vi.fn(), overview: vi.fn(), history: vi.fn(), run: vi.fn(), navigate: vi.fn(),
}));
vi.mock("@/api-sdk/projects-api", async (original) => ({ ...await original<object>(), getProject: mocks.project }));
vi.mock("@/api-sdk/metrics-api", async (original) => ({ ...await original<object>(), getProjectOverview: mocks.overview }));
vi.mock("@/api-sdk/runs-api", async (original) => ({
  ...await original<object>(), listProjectRuns: mocks.history, getProjectRun: mocks.run,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

const project = {
  projectId: "project", ownerUserId: "owner", name: "Old Project", sourceBranch: "eval", createdAt: "2026-11-02T00:00:00Z",
};
const projectView = {
  project, runSequence: 2, currentRun: { runId: "new-run" },
  execution: {
    harness: { kind: "sp", framework: "sp", agentConfig: { ownerUserId: "owner", userAgentId: "agent" } },
    subjectAgentConfig: { sourceUserAgentId: "agent", name: "Agent", body: {} },
    executionConcurrency: 1, retryPolicy: { maxRestarts: 0, initialBackoffMs: 250, maxBackoffMs: 10_000 },
  },
  evaluation: null, datasets: [], projectSamples: [],
};

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.project.mockResolvedValue(projectView);
  mocks.overview.mockResolvedValue({
    project, runIds: ["new-run"], datasets: [], projectSamples: [],
    summary: metricSummary(resourceStatistics(), resourceStatistics()),
  });
  mocks.history.mockResolvedValue({
    runs: [
      { runId: "new-run", sequence: 2, operation: "execution", retainedSamplingCount: 2, retainedEvaluationCount: 0 },
      { runId: "old-run", sequence: 1, operation: "execution", retainedSamplingCount: 0, retainedEvaluationCount: 0 },
    ],
    nextBeforeSequence: null,
  });
  mocks.run.mockResolvedValue({ run: {
    runId: "new-run", operation: "execution", status: "running", phase: "execution", samplingIds: ["one", "two"], evaluationIds: [],
  } });
});

async function openHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <TooltipProvider><QueryClientProvider client={client}><ProjectDetailPage projectId="project" /></QueryClientProvider></TooltipProvider>,
  );
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => {
    [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "运行记录")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("运行记录");
  return { ...view, close: async () => { await view.unmount(); client.clear(); } };
}

it("shows the old Run after a full rerun replaces every result", async () => {
  const view = await openHistory();
  try {
    await vi.waitFor(() => expect(view.container.textContent).toContain("new-run"));
    expect(view.container.textContent).toContain("old-run");
    expect(view.container.textContent).toContain("结果已替换");
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith("project", undefined, expect.any(AbortSignal));
    expect(mocks.run.mock.calls.every(([id, runId]) => id === "project" && runId === "new-run")).toBe(true);
  } finally { await view.close(); }
});

it("loads older persisted Runs beyond the first page", async () => {
  mocks.project.mockResolvedValue({ ...projectView, runSequence: 21, currentRun: null });
  mocks.history.mockImplementation(async (_projectId: string, beforeSequence?: number) => beforeSequence === undefined
    ? { runs: Array.from({ length: 20 }, (_, index) => ({
      runId: `history-run-${21 - index}`, sequence: 21 - index, operation: "execution",
      retainedSamplingCount: 1, retainedEvaluationCount: 0,
    })), nextBeforeSequence: 2 }
    : { runs: [{ runId: "old-run", sequence: 1, operation: "execution",
      retainedSamplingCount: 0, retainedEvaluationCount: 0 }], nextBeforeSequence: null });
  const view = await openHistory();
  try {
    await vi.waitFor(() => expect(view.container.textContent).toContain("第 21 次"));
    expect(view.container.textContent).not.toContain("old-run");
    await click([...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "下一页")!);
    await vi.waitFor(() => expect(view.container.textContent).toContain("old-run"));
    expect(view.container.textContent).toContain("结果已替换");
    expect(mocks.history.mock.calls.map(([id, cursor]) => [id, cursor]))
      .toEqual([["project", undefined], ["project", 2]]);
  } finally { await view.close(); }
});

it("marks an old evaluation-only Run as replaced when its evaluations are gone", async () => {
  mocks.history.mockResolvedValue({
    runs: [
      { runId: "new-run", sequence: 2, operation: "evaluation", retainedSamplingCount: 1, retainedEvaluationCount: 1 },
      { runId: "old-evaluation", sequence: 1, operation: "evaluation", retainedSamplingCount: 1, retainedEvaluationCount: 0 },
    ],
    nextBeforeSequence: null,
  });
  const view = await openHistory();
  try {
    await vi.waitFor(() => expect(view.container.textContent).toContain("old-eval"));
    expect(view.container.textContent).toContain("结果已替换");
    expect(mocks.run.mock.calls.some(([, runId]) => runId === "old-evaluation")).toBe(false);
  } finally { await view.close(); }
});
