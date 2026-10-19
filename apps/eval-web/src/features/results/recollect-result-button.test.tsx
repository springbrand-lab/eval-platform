import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { click, render } from "@/test/render";
import { RecollectResultButton } from "./recollect-result-button";
const api = vi.hoisted(() => ({ collect: vi.fn(), run: vi.fn(), detail: vi.fn(), refresh: vi.fn() }));
vi.mock("@/api-sdk/runs-api", () => ({ recollectResult: api.collect, getProjectRun: api.run }));
vi.mock("@/api-sdk/metrics-api", () => ({ getSamplingDetail: api.detail }));
vi.mock("@/features/projects/use-project", () => ({ refreshProjectResults: api.refresh }));
beforeEach(() => { Object.values(api).forEach((mock) => mock.mockReset()); api.collect.mockResolvedValue({ runId: "run", queued: true }); api.run.mockResolvedValue({ run: { status: "failed" } }); api.detail.mockResolvedValue({ subject: { stage: { status: "succeeded" } }, evaluations: [{ agent: { stage: { status: "succeeded" } }, record: { evaluationId: "evaluation" } }] }); });
type Props = Parameters<typeof RecollectResultButton>[0];
const complete = { collected: 1, pending: 0, failed: 0, uncollected: 0, unsubmitted: 0, finalized: 1 };
async function mount(evaluationId?: string, eligible = true, busy = false, extra: Partial<Props> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const screen = await render(<QueryClientProvider client={client}><RecollectResultButton projectId="project" samplingId="sampling" evaluationId={evaluationId} stage={{ status: "failed" }} resources={complete} eligible={eligible} busy={busy} {...extra} /></QueryClientProvider>);
  return { ...screen, close: async () => { await screen.unmount(); client.clear(); } };
}
it.each([undefined, "evaluation"])("collects only the selected completed stage and refreshes results: %s", async (evaluationId) => {
  const view = await mount(evaluationId);
  try {
    expect(view.container.textContent).toContain("不重新运行 Agent");
    await click(view.container.querySelector('button'));
    await vi.waitFor(() => expect(api.refresh).toHaveBeenCalled());
    expect(api.collect).toHaveBeenCalledExactlyOnceWith("project", evaluationId ? "evaluations" : "samplings", evaluationId ?? "sampling", "output");
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
it("offers no resource recollection when resources are complete", async () => {
  const view = await mount(undefined, true, false, { stage: { status: "succeeded" }, resources: complete });
  try { expect(view.container.querySelector('[data-testid="recollect-result"]')).toBeNull(); }
  finally { await view.close(); }
});
it("offers no resource recollection while the stage is still active", async () => {
  const view = await mount(undefined, true, false, { stage: { status: "retrying", evidencePending: true }, resources: { ...complete, failed: 1 } });
  try { expect(view.container.querySelector('[data-testid="recollect-resources"]')).toBeNull(); }
  finally { await view.close(); }
});
it.each([undefined, "evaluation"])("recollects only resources for failed or unfinalized snapshots: %s", async (evaluationId) => {
  api.detail.mockResolvedValue({
    subject: { stage: { status: "succeeded" }, resources: { collections: complete } },
    evaluations: [{ agent: { stage: { status: "succeeded" }, resources: { collections: complete } }, record: { evaluationId: "evaluation" } }],
  });
  const view = await mount(evaluationId, true, false, { stage: { status: "succeeded" }, resources: { ...complete, collected: 2, failed: 1 } });
  try {
    expect(view.container.querySelector('[data-testid="recollect-output"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="resource-collection-notes"]')?.textContent).toContain("资源采集失败 1 个");
    expect(view.container.textContent).toContain("1 个资源快照未定稿");
    const button = view.container.querySelector<HTMLButtonElement>('[data-testid="recollect-resources"]');
    expect(button?.textContent).toBe("重新采集资源");
    await click(button);
    await vi.waitFor(() => expect(api.refresh).toHaveBeenCalled());
    expect(api.collect).toHaveBeenCalledExactlyOnceWith("project", evaluationId ? "evaluations" : "samplings", evaluationId ?? "sampling", "resources");
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  } finally { await view.close(); }
});
it("reports resources that are still incomplete after recollection", async () => {
  api.detail.mockResolvedValue({ subject: { stage: { status: "succeeded" }, resources: { collections: { ...complete, failed: 1 } } }, evaluations: [] });
  const view = await mount(undefined, true, false, { stage: { status: "succeeded" }, resources: { ...complete, failed: 1 } });
  try {
    await click(view.container.querySelector('[data-testid="recollect-resources"]'));
    await vi.waitFor(() => expect(view.container.textContent).toContain("资源仍未完整采集：失败 1 个"));
    expect(view.container.querySelector<HTMLButtonElement>('[data-testid="recollect-resources"]')?.disabled).toBe(false);
  } finally { await view.close(); }
});
it("shows a pending resource collection as in progress and blocks another request", async () => {
  const view = await mount(undefined, true, false, { stage: { status: "succeeded", resourcesPending: { deadline: "2026-01-01T00:10:00.000Z", lastError: "telemetry timeout" } }, resources: complete });
  try {
    const button = view.container.querySelector<HTMLButtonElement>('[data-testid="recollect-resources"]');
    expect(button?.textContent).toContain("补采资源中");
    expect(button?.disabled).toBe(true);
    expect(view.container.textContent).toContain("上次资源采集错误：telemetry timeout");
    await click(button);
    expect(api.collect).not.toHaveBeenCalled();
  } finally { await view.close(); }
});
it("treats a scheduled resource refresh as accepted, not as a failure", async () => {
  api.detail.mockResolvedValue({ subject: { stage: { status: "succeeded", resourcesPending: { deadline: "2026-01-01T00:10:00.000Z" } }, resources: { collections: { ...complete, failed: 1 } } }, evaluations: [] });
  const view = await mount(undefined, true, false, { stage: { status: "succeeded" }, resources: { ...complete, failed: 1 } });
  try {
    await click(view.container.querySelector('[data-testid="recollect-resources"]'));
    await vi.waitFor(() => expect(api.refresh).toHaveBeenCalled());
    expect(api.collect).toHaveBeenCalledExactlyOnceWith("project", "samplings", "sampling", "resources");
    expect(view.container.textContent).not.toContain("资源仍未完整采集");
  } finally { await view.close(); }
});
