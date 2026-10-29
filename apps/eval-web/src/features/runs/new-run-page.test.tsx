import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@springbrand/http/client";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RunOperation, RunPreview, RunTargetSelector } from "@/api-sdk/types";
import { click, render, type } from "@/test/render";
import { NewRunPage } from "./new-run-page";

const mocks = vi.hoisted(() => ({ project: vi.fn(), preview: vi.fn(), submit: vi.fn(), navigate: vi.fn(), sample: vi.fn() }));
vi.mock("@/api-sdk/projects-api", async (original) => ({ ...await original<object>(), getProject: mocks.project }));
vi.mock("@/api-sdk/runs-api", async (original) => ({ ...await original<object>(), previewRun: mocks.preview, submitRun: mocks.submit }));
vi.mock("@/api-sdk/metrics-api", async (original) => ({ ...await original<object>(), getSampleOverview: mocks.sample }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate, Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

function preview(operation: RunOperation, selector: RunTargetSelector = { all: true }): RunPreview {
  return { projectId: "project", operation, selector, targets: { projectSampleIds: ["sample"], samplingIds: ["sampling"] },
    newSamplingCount: operation === "evaluation" ? 0 : 1, replacedSamplingCount: operation === "evaluation" ? 0 : 1,
    evaluationCount: operation === "execution" ? 0 : 1, executionPlanDigest: "execution", evaluationPlanDigest: operation === "execution" ? null : "evaluation" };
}
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

beforeEach(() => {
  mocks.project.mockReset(); mocks.preview.mockReset(); mocks.submit.mockReset(); mocks.navigate.mockReset(); mocks.sample.mockReset();
  mocks.project.mockResolvedValue({ project: { projectId: "project", name: "项目" }, currentRun: null, evaluation: {}, datasets: [], projectSamples: [] });
  mocks.preview.mockImplementation(async (_id: string, input: { operation: RunOperation; selector: RunTargetSelector }) => preview(input.operation, input.selector));
  mocks.submit.mockResolvedValue({ runId: "run" });
});

function selectionProject() {
  return { project: { projectId: "project", name: "项目" }, currentRun: null, evaluation: {},
    datasets: [
      { datasetId: "d1", name: "基础布局", projectSampleIds: ["a"] },
      { datasetId: "d2", name: "交互布局", projectSampleIds: ["a", "b"] },
    ],
    projectSamples: ["a", "b"].map((id) => ({ projectSampleId: id, datasetIds: id === "a" ? ["d1", "d2"] : ["d2"],
      samplingCount: 2, data: { dataId: id, name: `用例 ${id}`, userPrompt: `任务 ${id}` } })),
  };
}

const picker = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
const popup = () => document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
function choice(label: string) {
  const item = [...document.querySelectorAll("label")].find((item) => item.querySelector("[title]")?.getAttribute("title") === label)!;
  return document.getElementById(item.htmlFor) as HTMLButtonElement;
}

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
    expect(mocks.submit.mock.calls[0]?.[1]).toMatchObject({ operation: "evaluation", targets: preview("evaluation").targets,
      expectedPlanDigests: { execution: "execution", evaluation: "evaluation" } });
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
    expect(command).toMatchObject({ expectedPlanDigests: { execution: "execution" } });
    expect(command.expectedPlanDigests).not.toHaveProperty("evaluation");
    mocks.preview.mockResolvedValue({ ...preview("execution"), executionPlanDigest: "unapproved-new-plan" });
    await click(button(view.container, "重试提交")); await flush();
    expect(mocks.submit.mock.calls[1]?.[1]).toEqual(command);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ params: { projectId: "project", runId: "run" } }));
  } finally { await view.close(); }
});

it.each(["RUN_TARGETS_STALE", "PROJECT_PLAN_CHANGED"] as const)(
  "clears a %s preview and requires a new preview", async (code) => {
    mocks.submit.mockRejectedValueOnce(new ApiError({ kind: "http", code, status: 409, message: "stale" }));
    const view = await page();
    try {
      await click(button(view.container, "预览")); await flush();
      await click(button(view.container, "提交 Run")); await flush();
      expect(button(view.container, "提交 Run").disabled).toBe(true);
      expect(view.container.querySelector("fieldset")?.disabled).toBe(false);
      expect(view.container.textContent).toContain(code === "PROJECT_PLAN_CHANGED" ? "计划有变化" : "目标已变化");
      if (code === "PROJECT_PLAN_CHANGED") {
        mocks.preview.mockResolvedValueOnce({ ...preview("execution"), executionPlanDigest: "new-reviewed-digest" });
      }
      await click(button(view.container, "预览")); await flush();
      expect(button(view.container, "提交 Run").disabled).toBe(false);
      if (code === "PROJECT_PLAN_CHANGED") {
        await click(button(view.container, "提交 Run")); await flush();
        expect(mocks.submit.mock.calls[1]?.[1].expectedPlanDigests)
          .toEqual({ execution: "new-reviewed-digest" });
      }
    } finally { await view.close(); }
  },
);

it("keeps hidden Dataset selections while searching and invalidates the preview when cleared", async () => {
  mocks.project.mockResolvedValue(selectionProject());
  const view = await page();
  try {
    await click(picker(view.container));
    await click(choice("项目"));
    await click(choice("基础布局"));
    await type(popup().querySelector('[aria-label="搜索数据集或用例"]'), "交互");
    await click(choice("交互布局"));
    expect(view.container.textContent).toContain("2 个数据集");
    await click(picker(view.container));
    await click(button(view.container, "预览")); await flush();
    expect(mocks.preview.mock.calls.at(-1)?.[1]).toEqual({ operation: "execution", selector: { datasetIds: ["d1", "d2"] } });
    expect(button(view.container, "提交 Run").disabled).toBe(false);
    await click(picker(view.container));
    await type(popup().querySelector('[aria-label="搜索数据集或用例"]'), "无匹配");
    expect(popup().textContent).toContain("没有匹配的数据集或用例");
    expect(view.container.textContent).toContain("2 个数据集");
    await click(button(popup(), "清空选择"));
    await click(picker(view.container));
    expect(button(view.container, "提交 Run").disabled).toBe(true);
    expect(button(view.container, "预览").disabled).toBe(true);
  } finally { await view.close(); }
});

it("combines Sampling choices across cases and prunes descendants when a Dataset is selected", async () => {
  mocks.project.mockResolvedValue(selectionProject());
  mocks.sample.mockImplementation(async (_project: string, id: string) => ({ samplings: [1, 2].map((index) => ({
    samplingId: `${id}-${index}`, execution: { status: "succeeded" },
  })) }));
  const view = await page();
  try {
    await click(picker(view.container));
    await click(choice("项目"));
    await click(popup().querySelector('[aria-label="展开 基础布局"]'));
    await click(popup().querySelector('[aria-label="展开 用例 a"]')); await flush();
    await click(choice("采样 1 · a-1"));
    expect(choice("基础布局").getAttribute("aria-checked")).toBe("mixed");
    await click(popup().querySelector('[aria-label="展开 交互布局"]'));
    await click(popup().querySelector('[aria-label="展开 用例 b"]')); await flush();
    await click(choice("采样 1 · b-1"));
    expect(view.container.textContent).toContain("2 个采样");
    await click(picker(view.container));
    await click(button(view.container, "预览")); await flush();
    expect(mocks.preview.mock.calls.at(-1)?.[1].selector).toEqual({ samplingIds: ["a-1", "b-1"] });
    await click(picker(view.container));
    await click(choice("基础布局"));
    await click(picker(view.container));
    await click(button(view.container, "预览")); await flush();
    expect(mocks.preview.mock.calls.at(-1)?.[1].selector).toEqual({ datasetIds: ["d1"], samplingIds: ["b-1"] });
  } finally { await view.close(); }
});

it("freezes selection rows and clear actions while replaying an uncertain Dataset submission", async () => {
  mocks.project.mockResolvedValue(selectionProject());
  mocks.submit.mockRejectedValueOnce(new ApiError({ kind: "network", code: "NETWORK_ERROR", status: 0, message: "ack lost" }));
  const view = await page();
  try {
    await click(picker(view.container));
    await click(choice("项目"));
    await click(choice("基础布局"));
    await click(button(view.container, "预览")); await flush();
    await click(button(view.container, "提交 Run")); await flush();
    const command = mocks.submit.mock.calls[0]?.[1];
    expect(picker(view.container).disabled).toBe(true);
    if (popup()) {
      await click(choice("交互布局"));
      expect(choice("交互布局").disabled).toBe(true);
      expect(button(popup(), "清空选择").disabled).toBe(true);
    }
    expect(view.container.textContent).toContain("1 个数据集");
    await click(button(view.container, "重试提交")); await flush();
    expect(mocks.submit.mock.calls[1]?.[1]).toEqual(command);
  } finally { await view.close(); }
});
