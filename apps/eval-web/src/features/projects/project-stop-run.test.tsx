import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { projectKeys } from "@/api-sdk/projects-api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { click, render } from "@/test/render";
import { ProjectDetailPage } from "./project-detail-page";

const mocks = vi.hoisted(() => ({ project: vi.fn(), stop: vi.fn() }));
vi.mock("@/api-sdk/projects-api", async (original) => ({ ...await original<object>(), getProject: mocks.project }));
vi.mock("@/api-sdk/metrics-api", async (original) => ({ ...await original<object>(), getProjectOverview: async () => null }));
vi.mock("@/api-sdk/runs-api", async (original) => ({ ...await original<object>(), stopRun: mocks.stop,
  getProjectRun: async (_projectId: string, runId: string) => ({ run: { runId, status: "running", phase: "execution", operation: "execution" } }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
function project(runId: string, runSequence: number) {
  return { project: { projectId: "p", name: "项目", sourceBranch: "eval", createdAt: "2026-10-15T00:00:00Z" }, runSequence, currentRun: { runId }, evaluation: null,
    execution: { subjectAgentConfig: { name: "Subject" }, executionConcurrency: 1, retryPolicy: { maxRestarts: 0 }, harness: {} } };
}

it("stops the confirmed Run even when the next Run replaces the current pointer", async () => {
  mocks.project.mockResolvedValue(project("run-one", 1)); mocks.stop.mockResolvedValue({ runId: "run-one", stopRequested: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><ProjectDetailPage projectId="p" /></QueryClientProvider></TooltipProvider>);
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await click([...view.container.querySelectorAll("button")].find((button) => button.textContent === "停止"));
    await act(async () => { client.setQueryData(projectKeys.detail("p"), { ...project("run-one", 1), currentRun: null }); });
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("run-one");
    await act(async () => { client.setQueryData(projectKeys.detail("p"), project("run-two", 2)); });
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("run-one");
    await click([...dialog.querySelectorAll("button")].find((button) => button.textContent === "停止"));
    expect(mocks.stop).toHaveBeenCalledWith("p", "run-one");
    expect(mocks.stop).not.toHaveBeenCalledWith("p", "run-two");
  } finally { await view.unmount(); client.clear(); }
});
