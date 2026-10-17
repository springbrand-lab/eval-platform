import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@springbrand/http/client";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { inputLimits } from "@/test/input-limits";
import { click, render, select, type } from "@/test/render";
import { NewProjectPage } from "./new-project-page";

const mocks = vi.hoisted(() => ({ create: vi.fn(), navigate: vi.fn(), members: [{ dataId: "data", name: "样本", description: "说明", userPrompt: "start", evalPrompt: "judge" }] }));
vi.mock("@/api-sdk/projects-api", async (original) => ({ ...await original<object>(), createProject: mocks.create }));
vi.mock("@/api-sdk/input-limits-api", async (original) => ({ ...await original<object>(), getInputLimits: async () => inputLimits }));
vi.mock("@/api-sdk/datasets-api", async (original) => ({ ...await original<object>(),
  listDatasets: async () => [{ datasetId: "dataset", name: "数据集" }],
  listDatasetData: async () => mocks.members,
}));
vi.mock("@/api-sdk/agent-configs-api", async (original) => ({ ...await original<object>(),
  listAgentOptions: async (role: string) => [{ name: role, agentConfig: { userAgentId: role } }],
}));
vi.mock("@/api-sdk/output-schemas-api", async (original) => ({ ...await original<object>(), listOutputSchemas: async () => [{ outputSchemaId: "schema", name: "评分" }] }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate, Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
const control = (_container: HTMLElement, text: string) => document.getElementById([...document.querySelectorAll("label")].find((item) => item.textContent === text || item.querySelector("[title]")?.getAttribute("title") === text)!.htmlFor)!;

beforeEach(() => {
  mocks.members = [{ dataId: "data", name: "样本", description: "说明", userPrompt: "start", evalPrompt: "judge" }];
  mocks.create.mockReset(); mocks.navigate.mockReset(); mocks.create.mockResolvedValue({ project: { projectId: "created" }, run: { runId: "run" } });
});

async function page() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><NewProjectPage /></QueryClientProvider></TooltipProvider>);
  await flush(); await flush();
  return { ...view, close: async () => { await view.unmount(); client.clear(); } };
}

async function prepare(container: HTMLElement) {
  await type(control(container, "名称"), "测试项目");
  expect(button(container, "添加数据集")).toBeDefined();
  expect([...container.querySelectorAll("label")].some((item) => item.textContent === "样本")).toBe(false);
  await click(button(container, "添加数据集")); await flush();
  expect(control(container, "样本")).toBeDefined();
  await click(control(container, "数据集")); await flush();
  await click(button(container, "下一步"));
  await type(control(container, "每条用例采样次数"), "3");
  await click(button(container, "下一步"));
  await select(control(container, "执行 Agent"), "subject");
  await click(button(container, "下一步"));
  await click(control(container, "现在填写"));
}

it("cancels a filled creation without writing a Project or Run", async () => {
  const view = await page();
  try {
    await prepare(view.container);
    expect(button(view.container, "创建并运行").disabled).toBe(false);
    await click(button(view.container, "取消"));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/projects" });
  } finally { await view.close(); }
});

it("keeps the per-sample count input mounted and focused while entering multiple digits", async () => {
  const view = await page();
  try {
    await type(control(view.container, "名称"), "测试项目");
    await click(button(view.container, "添加数据集")); await flush();
    await click(control(view.container, "数据集")); await flush();
    await click(button(view.container, "下一步"));
    const input = view.container.querySelector<HTMLInputElement>('[aria-label="样本的采样次数"]')!;
    input.focus();
    await type(input, "2");
    expect(input.isConnected).toBe(true);
    expect(document.activeElement).toBe(input);
    await type(input, "20");
    expect(input.value).toBe("20");
    expect(document.activeElement).toBe(input);
  } finally { await view.close(); }
});

it("replays an execution-only creation unchanged after an unknown outcome", async () => {
  mocks.create.mockRejectedValueOnce(new ApiError({ kind: "network", code: "NETWORK_ERROR", status: 0, message: "ack lost" }));
  const view = await page();
  try {
    await prepare(view.container);
    await click(button(view.container, "创建并运行")); await flush();
    const input = mocks.create.mock.calls[0]?.[0];
    expect(input).toMatchObject({ name: "测试项目", samplingCount: 3, run: { operation: "execution" }, execution: { userAgentId: "subject" } });
    expect(input).not.toHaveProperty("evaluation");
    expect(view.container.querySelector("fieldset")?.disabled).toBe(true);
    expect(view.container.textContent).toContain("提交结果尚未确认");
    await click(button(view.container, "重试创建")); await flush();
    expect(mocks.create.mock.calls[1]?.[0]).toEqual(input);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/projects/$projectId", params: { projectId: "created" } });
  } finally { await view.close(); }
});

it("shows groups inline, retains selection through collapse and search, and keeps explicit case IDs", async () => {
  mocks.members.push({ ...mocks.members[0]!, dataId: "second", name: "第二用例" });
  const view = await page();
  try {
    expect(button(view.container, "添加数据集")).toBeDefined();
    await type(control(view.container, "名称"), "测试项目");
    await click(button(view.container, "添加数据集")); await flush();
    await click(control(view.container, "样本"));
    await flush();
    expect(control(view.container, "数据集").getAttribute("aria-checked")).toBe("mixed");
    await click(view.container.querySelector('[aria-label="收起 数据集"]'));
    expect(view.container.textContent).toContain("已选 1 条用例");
    await click(view.container.querySelector('[aria-label="展开 数据集"]'));
    await flush();
    expect(control(view.container, "样本").getAttribute("aria-checked")).toBe("true");
    const search = view.container.querySelector<HTMLInputElement>('[aria-label="搜索数据集"]')!;
    await type(search, "没有匹配");
    expect(view.container.textContent).toContain("已选 1 条用例");
    await type(search, ""); await flush();
    await click(control(view.container, "第二用例")); await flush();
    expect(control(view.container, "数据集").getAttribute("aria-checked")).toBe("true");
    await click(button(view.container, "下一步"));
    await click(button(view.container, "下一步"));
    await select(control(view.container, "执行 Agent"), "subject");
    await click(button(view.container, "下一步"));
    await click(control(view.container, "现在填写"));
    await click(button(view.container, "创建并运行")); await flush();
    expect(mocks.create.mock.calls[0]?.[0].datasets).toEqual([{ datasetId: "dataset", dataIds: ["data", "second"] }]);
  } finally { await view.close(); }
});

it("preselects the source Dataset without creating a Project", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><NewProjectPage datasetId="dataset" /></QueryClientProvider></TooltipProvider>);
  try {
    await vi.waitFor(() => expect(view.container.textContent).toContain("已选 1 条用例"));
    expect(control(view.container, "样本").getAttribute("aria-checked")).toBe("true");
    expect(view.container.textContent).toContain("不会更新已有项目");
    expect(mocks.create).not.toHaveBeenCalled();
  } finally { await view.unmount(); client.clear(); }
});
