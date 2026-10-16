import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { projectKeys } from "@/api-sdk/projects-api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { render } from "@/test/render";
import { ObservationPage } from "./observation-page";

const mocks = vi.hoisted(() => ({
  project: vi.fn(), messages: vi.fn(), ref: vi.fn(),
}));
vi.mock("@/api-sdk/projects-api", async (original) => ({ ...await original<object>(), getProject: mocks.project }));
vi.mock("@/api-sdk/observations-api", async (original) => ({ ...await original<object>(), getMessages: mocks.messages, getObservationRef: mocks.ref }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("./messages-tab", () => ({ MessagesTab: ({ messages, running }: { messages: unknown; running: boolean }) => <div>{JSON.stringify(messages)} {running ? "running" : "finished"}</div> }));
vi.mock("./workspace-tab", () => ({ WorkspaceTab: () => null }));
vi.mock("./trajectory-tab", () => ({ TrajectoryTab: () => null }));

it("refreshes the final read-only Context after a Run finishes", async () => {
  mocks.project.mockResolvedValue({ project: { name: "project" }, currentRun: { runId: "run" } });
  mocks.messages.mockResolvedValue(["live context"]);
  mocks.ref.mockResolvedValue({ state: "available", chatId: "chat", samplingId: "s" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><ObservationPage projectId="p" target={{ role: "subject", id: "s" }} /></QueryClientProvider></TooltipProvider>);
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(view.container.textContent).toContain("live context");
    expect(view.container.textContent).toContain("running");
    const reads = mocks.messages.mock.calls.length;
    mocks.messages.mockResolvedValue(["final context"]);
    mocks.project.mockResolvedValue({ project: { name: "project" }, currentRun: null });
    await act(async () => { await client.invalidateQueries({ queryKey: projectKeys.detail("p") }); await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(mocks.messages.mock.calls.length).toBeGreaterThan(reads);
    expect(view.container.textContent).toContain("final context");
    expect(view.container.textContent).toContain("finished");
    expect(view.container.querySelector("textarea")).toBeNull();
  } finally { await view.unmount(); client.clear(); }
});
