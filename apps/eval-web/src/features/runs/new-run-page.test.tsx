import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@springbrand/http/client";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RunOperation, RunPreview, RunTargetSelector } from "@/api-sdk/types";
import { click, render } from "@/test/render";
import { NewRunPage } from "./new-run-page";

const mocks = vi.hoisted(() => ({ project: vi.fn(), preview: vi.fn(), submit: vi.fn(), navigate: vi.fn() }));
vi.mock("@/api-sdk/projects-api", async (original) => ({ ...await original<object>(), getProject: mocks.project }));
vi.mock("@/api-sdk/runs-api", async (original) => ({ ...await original<object>(), previewRun: mocks.preview, submitRun: mocks.submit }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate, Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

function preview(operation: RunOperation, selector: RunTargetSelector = { all: true }): RunPreview {
  return { projectId: "project", operation, selector, targets: { projectSampleIds: ["sample"], samplingIds: ["sampling"] },
    newSamplingCount: operation === "evaluation" ? 0 : 1, replacedSamplingCount: operation === "evaluation" ? 0 : 1,
    evaluationCount: operation === "execution" ? 0 : 1, executionPlanDigest: "execution", evaluationPlanDigest: operation === "execution" ? null : "evaluation" };
}
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

beforeEach(() => {
  mocks.project.mockReset(); mocks.preview.mockReset(); mocks.submit.mockReset(); mocks.navigate.mockReset();
  mocks.project.mockResolvedValue({ project: { projectId: "project", name: "项目" }, currentRun: null, evaluation: {}, datasets: [], projectSamples: [] });
  mocks.preview.mockImplementation(async (_id: string, input: { operation: RunOperation; selector: RunTargetSelector }) => preview(input.operation, input.selector));
  mocks.submit.mockResolvedValue({ runId: "run" });
});

async function page() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><NewRunPage projectId="project" /></QueryClientProvider></TooltipProvider>);
  await flush();
  return { ...view, close: async () => { await view.unmount(); client.clear(); } };
}

it("does not submit a late preview after the operation changed", async () => {
  let finish!: (value: RunPreview) => void;
  mocks.preview.mockReturnValueOnce(new Promise<RunPreview>((resolve) => { finish = resolve; }));
  const view = await page();
  try {
    await click(button(view.container, "预览"));
    await click([...view.container.querySelectorAll('[role="radio"]')].find((item) => item.textContent?.startsWith("只评估")));
    await act(async () => finish(preview("execution")));
    await flush();
    expect(button(view.container, "提交 Run").disabled).toBe(true);
    await click(button(view.container, "提交 Run"));
    expect(mocks.submit).not.toHaveBeenCalled();
    await click(button(view.container, "预览")); await flush();
    await click(button(view.container, "提交 Run")); await flush();
    expect(mocks.submit.mock.calls[0]?.[1]).toMatchObject({ operation: "evaluation", targets: preview("evaluation").targets });
  } finally { await view.close(); }
});

it("replays the captured command after an uncertain submission, even when the server now has a current Run", async () => {
  mocks.submit.mockImplementationOnce(async () => {
    mocks.project.mockResolvedValue({ project: { projectId: "project", name: "项目" }, currentRun: { runId: "run" }, evaluation: {}, datasets: [], projectSamples: [] });
    throw new ApiError({ kind: "network", code: "NETWORK_ERROR", status: 0, message: "ack lost" });
  });
  const view = await page();
  try {
    await click(button(view.container, "预览")); await flush();
    await click(button(view.container, "提交 Run")); await flush();
    expect(view.container.textContent).toContain("提交结果尚未确认");
    expect(view.container.querySelector("fieldset")?.disabled).toBe(true);
    const command = mocks.submit.mock.calls[0]?.[1];
    await click(button(view.container, "重试提交")); await flush();
    expect(mocks.submit.mock.calls[1]?.[1]).toEqual(command);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ params: { projectId: "project", runId: "run" } }));
  } finally { await view.close(); }
});

it("clears a stale target preview and requires a new preview", async () => {
  mocks.submit.mockRejectedValueOnce(new ApiError({ kind: "http", code: "RUN_TARGETS_STALE", status: 409, message: "stale" }));
  const view = await page();
  try {
    await click(button(view.container, "预览")); await flush();
    await click(button(view.container, "提交 Run")); await flush();
    expect(button(view.container, "提交 Run").disabled).toBe(true);
    expect(view.container.querySelector("fieldset")?.disabled).toBe(false);
    expect(view.container.textContent).toContain("目标已变化");
    await click(button(view.container, "预览")); await flush();
    expect(button(view.container, "提交 Run").disabled).toBe(false);
  } finally { await view.close(); }
});
