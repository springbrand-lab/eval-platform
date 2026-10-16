import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { click, render } from "@/test/render";
import { RecollectResultButton } from "./recollect-result-button";
const api = vi.hoisted(() => ({ collect: vi.fn(), run: vi.fn(), detail: vi.fn(), refresh: vi.fn() }));
vi.mock("@/api-sdk/runs-api", () => ({ recollectResult: api.collect, getProjectRun: api.run }));
vi.mock("@/api-sdk/metrics-api", () => ({ getSamplingDetail: api.detail }));
vi.mock("@/features/projects/use-project", () => ({ refreshProjectResults: api.refresh }));
beforeEach(() => { Object.values(api).forEach((mock) => mock.mockReset()); api.collect.mockResolvedValue({ runId: "run", queued: true }); api.run.mockResolvedValue({ run: { status: "failed" } }); api.detail.mockResolvedValue({ subject: { stage: { status: "succeeded" } }, evaluations: [{ record: { evaluationId: "evaluation", status: { status: "succeeded" } } }] }); });
async function mount(evaluationId?: string, eligible = true, busy = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const screen = await render(<QueryClientProvider client={client}><RecollectResultButton projectId="project" samplingId="sampling" evaluationId={evaluationId} stage={{ status: "failed" }} eligible={eligible} busy={busy} /></QueryClientProvider>);
  return { ...screen, close: async () => { await screen.unmount(); client.clear(); } };
}
it.each([undefined, "evaluation"])("collects only the selected completed stage and refreshes results: %s", async (evaluationId) => {
  const view = await mount(evaluationId);
  try {
    expect(view.container.textContent).toContain("不重新运行 Agent");
    await click(view.container.querySelector('button'));
    await vi.waitFor(() => expect(api.refresh).toHaveBeenCalled());
    expect(api.collect).toHaveBeenCalledExactlyOnceWith("project", evaluationId ? "evaluations" : "samplings", evaluationId ?? "sampling");
    expect(api.detail).toHaveBeenCalledWith("project", "sampling");
  } finally { await view.close(); }
});
it("retains a collection error and allows an explicit retry", async () => {
  api.detail.mockResolvedValue({ subject: { stage: { status: "failed", lastError: "still unavailable" } } });
  const view = await mount();
  try {
    await click(view.container.querySelector('button'));
    await vi.waitFor(() => expect(view.container.textContent).toContain("still unavailable"));
    expect(view.container.querySelector('button')?.disabled).toBe(false);
  } finally { await view.close(); }
});
it("hides ineligible recovery and blocks collection while the project is busy", async () => {
  const hidden = await mount(undefined, false); expect(hidden.container.querySelector('button')).toBeNull(); await hidden.close();
  const busy = await mount(undefined, true, true);
  try { expect(busy.container.querySelector('button')?.disabled).toBe(true); await click(busy.container.querySelector('button')); expect(api.collect).not.toHaveBeenCalled(); }
  finally { await busy.close(); }
});
