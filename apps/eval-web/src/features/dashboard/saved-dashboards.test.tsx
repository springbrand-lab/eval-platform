import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/api-sdk/client";
import type { Dashboard, DashboardCreateInput, DashboardUpdateInput, Project, ProjectComparisonQuery, ProjectComparisonView } from "@/api-sdk/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { comparisonProject, comparisonProjectView, comparisonRow, comparisonSampling, comparisonScore, comparisonView, savedDashboard, savedDashboardId } from "@/test/comparison";
import { inputLimits } from "@/test/input-limits";
import { click, render, select, type } from "@/test/render";
import { DashboardPage } from "./dashboard-page";
import { EditDashboardPage, NewDashboardPage } from "./dashboard-form-page";
import { dashboardEditSearchMiddleware, dashboardSearchMiddleware, validateDashboardEditSearch, validateDashboardReadSearch } from "./dashboard-search";

const api = vi.hoisted(() => ({
  list: vi.fn<() => Promise<Dashboard[]>>(), detail: vi.fn<(id: string, signal?: AbortSignal) => Promise<Dashboard>>(),
  create: vi.fn<(input: DashboardCreateInput) => Promise<Dashboard>>(), update: vi.fn<(id: string, input: DashboardUpdateInput) => Promise<Dashboard>>(),
  comparison: vi.fn(), sampling: vi.fn(), file: vi.fn(),
  projects: vi.fn<() => Promise<Project[]>>(),
}));
vi.mock("@/api-sdk/dashboards-api", async (original) => ({
  ...await original<object>(), listDashboards: api.list, getDashboard: api.detail, createDashboard: api.create, updateDashboard: api.update,
}));
vi.mock("@/api-sdk/projects-api", async (original) => ({
  ...await original<object>(), listProjects: api.projects,
  getProject: async (id: string) => comparisonProjectView(id),
}));
vi.mock("@/api-sdk/input-limits-api", async (original) => ({ ...await original<object>(), getInputLimits: async () => inputLimits }));
vi.mock("@/api-sdk/comparison-api", async (original) => ({ ...await original<object>(), getProjectComparison: api.comparison }));
vi.mock("@/api-sdk/metrics-api", async (original) => ({ ...await original<object>(), getSamplingDetail: api.sampling }));
vi.mock("@/api-sdk/runs-api", async (original) => ({ ...await original<object>(), listSamplingEvaluations: async () => [] }));
vi.mock("@/api-sdk/observations-api", async (original) => ({ ...await original<object>(), getWorkspaceFile: api.file }));
vi.mock("@/components/files/file-preview", () => ({
  FilePreview: ({ file }: { file: { path: string } }) => <span>产物 {file.path}</span>,
}));
vi.mock("@/features/observation/messages-tab", () => ({ MessagesTab: () => <div>只读会话</div> }));
vi.mock("@/features/observation/trajectory-tab", () => ({ TrajectoryTab: () => <div>只读轨迹</div> }));

beforeEach(() => {
  vi.clearAllMocks();
  api.list.mockResolvedValue([]);
  api.detail.mockResolvedValue(savedDashboard());
  api.create.mockImplementation(async (input) => savedDashboard({ ...input, description: input.description ?? "" }));
  api.update.mockImplementation(async (id, input) => savedDashboard({ ...input, dashboardId: id, description: input.description ?? "", revision: input.revision + 1 }));
  api.comparison.mockResolvedValue(comparisonView());
  api.sampling.mockImplementation(async (projectId: string, samplingId: string) => comparisonSampling(projectId, samplingId));
  api.file.mockResolvedValue(new Blob(["artifact"]));
  api.projects.mockResolvedValue(Array.from({ length: 22 }, (_, index) => comparisonProject(index + 1)));
  window.scrollTo = vi.fn();
});

const control = (container: ParentNode, label: string) => container.querySelector(`[aria-label="${label}"]`);
const button = (container: ParentNode, label: string) => [...container.querySelectorAll("button")].find((node) => node.textContent === label);
const link = (container: ParentNode, label: string) => [...container.querySelectorAll<HTMLAnchorElement>("a[href]")].find((node) => node.textContent === label);
async function waitFor(check: () => void) {
  let error: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    try { check(); return; } catch (failure) { error = failure; }
  }
  throw error;
}

async function changeView(container: ParentNode, label: string) {
  const tab = [...control(container, "对比展示视图")!.querySelectorAll("button")].find((node) => node.textContent === label)!;
  await act(async () => { tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); tab.click(); });
}

async function fillCreate(container: ParentNode, name = "稳定请求看板") {
  await waitFor(() => expect(control(container, "选择 项目 1")).not.toBeNull());
  await type(control(container, "看板名称"), name);
  await click(control(container, "选择 项目 1"));
  await click(control(container, "选择 项目 2"));
}

async function mount(path = "/dashboard") {
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => root, path: "/dashboard", validateSearch: validateDashboardReadSearch, search: { middlewares: [dashboardSearchMiddleware] },
    component: () => <DashboardPage search={route.useSearch()} />,
  });
  const create = createRoute({
    getParentRoute: () => root, path: "/dashboard/new", validateSearch: validateDashboardReadSearch, search: { middlewares: [dashboardSearchMiddleware] },
    component: () => <NewDashboardPage search={create.useSearch()} />,
  });
  const edit = createRoute({
    getParentRoute: () => root, path: "/dashboard/edit", validateSearch: validateDashboardEditSearch, search: { middlewares: [dashboardEditSearchMiddleware] },
    component: () => <EditDashboardPage search={edit.useSearch()} />,
  });
  const router = createRouter({ routeTree: root.addChildren([route, create, edit]), history: createMemoryHistory({ initialEntries: [path] }), defaultPendingMinMs: 0 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(<TooltipProvider><QueryClientProvider client={client}><main><RouterProvider router={router} /></main></QueryClientProvider></TooltipProvider>);
  await act(async () => { await router.load(); });
  return { ...screen, client, router, close: async () => { await screen.unmount(); client.clear(); } };
}

it("opens at the saved-dashboard directory with a clear empty state rather than an anonymous Project selection", async () => {
  const screen = await mount();
  try {
    await waitFor(() => expect(screen.container.textContent).toContain("还没有保存的看板"));
    expect(api.list).toHaveBeenCalledOnce();
    expect(link(screen.container, "新建看板")).toBeDefined();
    expect(control(screen.container, "选择 项目 1")).toBeNull();
    expect(api.comparison).not.toHaveBeenCalled();
  } finally { await screen.close(); }
});

it("names a new dashboard, selects Projects across pages, creates once and reopens the response's saved identity", async () => {
  const response = savedDashboard({ dashboardId: "71000000-0000-4000-8000-000000000099", name: "发布质量观察", description: "检查当前留存结果", projectIds: ["p1", "p21"] });
  api.create.mockResolvedValue(response);
  api.detail.mockResolvedValue(response);
  const screen = await mount();
  let shared = "";
  try {
    await waitFor(() => expect(screen.container.textContent).toContain("还没有保存的看板"));
    await click(link(screen.container, "新建看板"));
    await waitFor(() => expect(control(screen.container, "看板名称")).not.toBeNull());
    expect(button(screen.container, "开始对比")).toBeUndefined();
    expect([...screen.container.querySelectorAll("button")].filter((node) => node.textContent === "创建看板")).toHaveLength(1);
    await type(control(screen.container, "看板名称"), " 发布质量观察 ");
    await type(control(screen.container, "看板说明"), " 检查当前留存结果 ");
    await click(control(screen.container, "选择 项目 1"));
    expect(button(screen.container, "创建看板")?.disabled).toBe(true);
    await click(button(screen.container, "下一页"));
    await click(control(screen.container, "选择 项目 21"));
    await click(button(screen.container, "创建看板"));
    await waitFor(() => expect(screen.container.textContent).toContain("整体差异"));
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.create.mock.calls[0][0]).toMatchObject({ name: "发布质量观察", description: "检查当前留存结果", projectIds: ["p1", "p21"], idempotencyKey: expect.any(String) });
    expect(screen.router.state.location.search.dashboardId).toBe(response.dashboardId);
    expect(new URLSearchParams(screen.router.state.location.searchStr).has("projectId")).toBe(false);
    expect(api.comparison).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ["p1", "p21"] }), expect.any(AbortSignal));
    expect(api.detail).toHaveBeenCalledWith(response.dashboardId, expect.any(AbortSignal));
    shared = screen.router.state.location.href;
  } finally { await screen.close(); }
  const reopened = await mount(shared);
  try {
    await waitFor(() => expect(reopened.container.textContent).toContain("整体差异"));
    expect(reopened.container.textContent).toContain("发布质量观察");
    expect(api.detail.mock.calls.filter(([id]) => id === response.dashboardId).length).toBeGreaterThanOrEqual(2);
    expect(api.create).toHaveBeenCalledOnce();
  } finally { await reopened.close(); }
});

it("uses the saved server Project order rather than configuration parameters in a shared URL", async () => {
  api.detail.mockResolvedValue(savedDashboard({ projectIds: ["p2", "p1"] }));
  const screen = await mount(`/dashboard?${new URLSearchParams({ dashboardId: savedDashboardId, projectId: '["p3","p4"]', view: "compare", jsonPointer: "/score" })}`);
  try {
    await waitFor(() => expect(screen.container.textContent).toContain("整体差异"));
    expect(api.comparison).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ["p2", "p1"] }), expect.any(AbortSignal));
    expect(api.comparison.mock.calls.some(([query]) => query.projectIds.includes("p3"))).toBe(false);
    expect(new URLSearchParams(screen.router.state.location.searchStr).has("projectId")).toBe(false);
    expect(new URLSearchParams(screen.router.state.location.searchStr).has("view")).toBe(false);
    expect(api.create).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
  } finally { await screen.close(); }
});

it.each(["unknown", "rejected"] as const)("retries the original captured POST after a %s result without changing its idempotency key", async (outcome) => {
  const failure = outcome === "unknown"
    ? new ApiError({ status: 0, code: "NETWORK_ERROR", kind: "network", message: "响应中断" })
    : new ApiError({ status: 400, code: "REQUEST_VALIDATION_FAILED", message: "请求未接收" });
  const response = savedDashboard({ name: "稳定请求看板" });
  api.create.mockRejectedValueOnce(failure).mockResolvedValue(response);
  api.detail.mockResolvedValue(response);
  const screen = await mount("/dashboard/new");
  try {
    await fillCreate(screen.container);
    await click(button(screen.container, "创建看板"));
    await waitFor(() => expect(button(screen.container, "重试创建")).toBeDefined());
    const captured = api.create.mock.calls[0][0];
    if (outcome === "unknown") {
      expect(screen.container.textContent).toContain("创建结果尚未确认");
      await type(control(screen.container, "看板名称"), "不能替换未知请求");
      await click(control(screen.container, "选择 项目 3"));
      expect((control(screen.container, "看板名称") as HTMLInputElement).value).toBe("稳定请求看板");
    }
    await click(button(screen.container, "重试创建"));
    await waitFor(() => expect(screen.container.textContent).toContain("整体差异"));
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.create.mock.calls[1][0]).toBe(captured);
    expect(api.create.mock.calls[1][0].projectIds).toEqual(["p1", "p2"]);
    expect(api.create.mock.calls[1][0].idempotencyKey).toBe(captured.idempotencyKey);
  } finally { await screen.close(); }
});

it("admits only one pending create even when submit is clicked twice before the response", async () => {
  let resolve!: (dashboard: Dashboard) => void;
  api.create.mockImplementationOnce(() => new Promise<Dashboard>((done) => { resolve = done; }));
  const screen = await mount("/dashboard/new");
  try {
    await fillCreate(screen.container);
    const submit = button(screen.container, "创建看板")!;
    await act(async () => { submit.click(); submit.click(); });
    expect(api.create).toHaveBeenCalledOnce();
    await waitFor(() => expect(submit.disabled).toBe(true));
    await act(async () => { resolve(savedDashboard({ name: "稳定请求看板" })); });
    await waitFor(() => expect(screen.container.textContent).toContain("整体差异"));
    expect(api.create).toHaveBeenCalledOnce();
  } finally { await screen.close(); }
});

it("requires an explicit revision-checked save and reloads a CAS conflict without overwriting the newer configuration", async () => {
  let current = savedDashboard({ revision: 4 });
  api.detail.mockImplementation(async () => current);
  api.update.mockImplementation(async (id, input) => {
    if (api.update.mock.calls.length === 1) {
      current = savedDashboard({ name: "其他人已更新", revision: 5, projectIds: ["p1", "p3"] });
      throw new ApiError({ status: 409, code: "DASHBOARD_REVISION_CONFLICT", message: "看板版本已变化" });
    }
    current = savedDashboard({ ...input, dashboardId: id, description: input.description ?? "", revision: input.revision + 1 });
    return current;
  });
  const reading = { dashboardId: savedDashboardId, jsonPointer: "/score", datasetId: "dataset-a", dataId: "data-0", sampling: '{"p1":"p1-data-0-valid-b"}', viewMode: "execution" };
  const screen = await mount(`/dashboard?${new URLSearchParams(reading)}`);
  try {
    await waitFor(() => expect(link(screen.container, "编辑看板")).toBeDefined());
    await click(link(screen.container, "编辑看板"));
    await waitFor(() => expect(control(screen.container, "看板名称")).not.toBeNull());
    await type(control(screen.container, "看板名称"), "我的草稿");
    expect(api.update).not.toHaveBeenCalled();
    await click(button(screen.container, "保存看板"));
    await waitFor(() => expect(screen.container.textContent).toContain("重新载入最新配置"));
    expect((control(screen.container, "看板名称") as HTMLInputElement).value).toBe("我的草稿");
    expect(screen.container.textContent).toContain("其他人已更新");
    expect(screen.container.textContent).toContain("版本 5");
    expect(api.update).toHaveBeenCalledOnce();
    expect(api.update.mock.calls[0][1]).toMatchObject({ revision: 4, name: "我的草稿" });
    await click(button(screen.container, "重新载入最新配置"));
    expect((control(screen.container, "看板名称") as HTMLInputElement).value).toBe("其他人已更新");
    expect(control(screen.container, "选择 项目 3")?.getAttribute("aria-checked")).toBe("true");
    await type(control(screen.container, "看板名称"), "确认后的看板");
    await click(button(screen.container, "保存看板"));
    await waitFor(() => expect(screen.container.textContent).toContain("单条数据表现"));
    expect(api.update.mock.calls[1][1]).toMatchObject({ revision: 5, name: "确认后的看板", projectIds: ["p1", "p3"] });
    expect(screen.router.state.location.search).toMatchObject({
      dashboardId: savedDashboardId, jsonPointer: "/score", datasetId: "dataset-a", dataId: "data-0",
      sampling: { p1: "p1-data-0-valid-b" }, viewMode: "execution",
    });
    expect(api.comparison).toHaveBeenLastCalledWith(expect.objectContaining({ projectIds: ["p1", "p3"] }), expect.any(AbortSignal));
  } finally { await screen.close(); }
});

it("confirms an uncertain PUT by reading the saved configuration instead of issuing another write", async () => {
  let current = savedDashboard();
  api.detail.mockImplementation(async () => current);
  api.update.mockImplementation(async (id, input) => {
    current = savedDashboard({ ...input, dashboardId: id, description: input.description ?? "", revision: input.revision + 1 });
    throw new ApiError({ status: 0, code: "NETWORK_ERROR", kind: "network", message: "响应中断" });
  });
  const screen = await mount(`/dashboard/edit?dashboardId=${savedDashboardId}`);
  try {
    await waitFor(() => expect(control(screen.container, "看板名称")).not.toBeNull());
    await type(control(screen.container, "看板名称"), "已确认保存的配置");
    await click(button(screen.container, "保存看板"));
    await waitFor(() => expect(screen.container.textContent).toContain("整体差异"));
    expect(screen.container.textContent).toContain("已确认保存的配置");
    expect(api.update).toHaveBeenCalledOnce();
    expect(api.detail.mock.calls.length).toBeGreaterThanOrEqual(2);
  } finally { await screen.close(); }
});

it("replays the captured PUT only when a fresh read confirms that its original revision is still current", async () => {
  let current = savedDashboard();
  api.detail.mockImplementation(async () => current);
  api.update.mockImplementation(async (id, input) => {
    if (api.update.mock.calls.length === 1) throw new ApiError({ status: 0, code: "NETWORK_ERROR", kind: "network", message: "连接中断" });
    current = savedDashboard({ ...input, dashboardId: id, description: input.description ?? "", revision: input.revision + 1 });
    return current;
  });
  const screen = await mount(`/dashboard/edit?dashboardId=${savedDashboardId}`);
  try {
    await waitFor(() => expect(control(screen.container, "看板名称")).not.toBeNull());
    await type(control(screen.container, "看板名称"), "重试原版本");
    await click(button(screen.container, "保存看板"));
    await waitFor(() => expect(button(screen.container, "重试保存")?.disabled).toBe(false));
    const captured = api.update.mock.calls[0][1];
    await click(button(screen.container, "重试保存"));
    await waitFor(() => expect(screen.container.textContent).toContain("整体差异"));
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(api.update.mock.calls[1][1]).toBe(captured);
    expect(captured.revision).toBe(1);
  } finally { await screen.close(); }
});

it("never replays an uncertain PUT over a different newer server configuration", async () => {
  let current = savedDashboard();
  api.detail.mockImplementation(async () => current);
  api.update.mockImplementation(async () => {
    current = savedDashboard({ name: "另一份新配置", revision: 2, projectIds: ["p1", "p3"] });
    throw new ApiError({ status: 0, code: "NETWORK_ERROR", kind: "network", message: "连接中断" });
  });
  const screen = await mount(`/dashboard/edit?dashboardId=${savedDashboardId}`);
  try {
    await waitFor(() => expect(control(screen.container, "看板名称")).not.toBeNull());
    await type(control(screen.container, "看板名称"), "保留待核对草稿");
    await click(button(screen.container, "保存看板"));
    await waitFor(() => expect(button(screen.container, "重新载入最新配置")).toBeDefined());
    expect(screen.container.textContent).toContain("另一份新配置");
    expect((control(screen.container, "看板名称") as HTMLInputElement).value).toBe("保留待核对草稿");
    expect(button(screen.container, "重试保存")?.disabled).toBe(true);
    expect(api.update).toHaveBeenCalledOnce();
  } finally { await screen.close(); }
});

it("opens an explicit edit draft when a comparison Project is removed and never writes on removal or cancel", async () => {
  const screen = await mount(`/dashboard?dashboardId=${savedDashboardId}&jsonPointer=/score&datasetId=dataset-a`);
  try {
    await waitFor(() => expect(control(screen.container, "移除 项目 2")).not.toBeNull());
    await click(control(screen.container, "移除 项目 2"));
    await waitFor(() => expect(control(screen.container, "选择 项目 1")).not.toBeNull());
    expect(control(screen.container, "选择 项目 1")?.getAttribute("aria-checked")).toBe("true");
    expect(control(screen.container, "选择 项目 2")?.getAttribute("aria-checked")).toBe("false");
    expect(button(screen.container, "保存看板")?.disabled).toBe(true);
    expect(api.update).not.toHaveBeenCalled();
    await click(button(screen.container, "取消编辑"));
    await waitFor(() => expect(screen.container.textContent).toContain("数据集表现"));
    expect(api.comparison).toHaveBeenLastCalledWith(expect.objectContaining({ projectIds: ["p1", "p2"] }), expect.any(AbortSignal));
    expect(screen.router.state.location.search.datasetId).toBe("dataset-a");
    expect(api.update).not.toHaveBeenCalled();
  } finally { await screen.close(); }
});

it("switches both metric views within the same reading scope without fetching analysis or writing configuration", async () => {
  const screen = await mount(`/dashboard?${new URLSearchParams({ dashboardId: savedDashboardId, jsonPointer: "/score", datasetId: "dataset-a", differences: "true", sort: "difference" })}`);
  const main = screen.container.querySelector("main")!;
  const firstData = () => control(screen.container, "逐条数据对比")!.querySelector("tbody td a")?.textContent;
  try {
    await waitFor(() => expect(control(screen.container, "对比展示视图")).not.toBeNull());
    await waitFor(() => expect(firstData()).toBe("用例 2"));
    expect((control(screen.container, "共同指标") as HTMLSelectElement).value).toBe("/score");
    const calls = api.comparison.mock.calls.length;
    main.scrollTop = 310;
    await changeView(screen.container, "执行指标");
    expect(firstData()).toBe("零分用例");
    expect(main.scrollTop).toBe(310);
    expect(control(screen.container, "共同指标")).toBeNull();
    expect(control(screen.container, "数据排序")).toBeNull();
    expect([...control(screen.container, "项目 1 表现")!.querySelectorAll('dl[aria-label="执行 Agent 指标"] dt')].map((term) => term.textContent))
      .toEqual(["平均执行积分", "平均执行耗时", "缓存命中率", "工具调用成功率"]);
    expect(button(screen.container, "切换到评估指标")).toBeUndefined();
    expect(screen.container.textContent).not.toContain("仅评分不同");
    expect(api.comparison).toHaveBeenCalledTimes(calls);
    expect(screen.router.state.location.search).toMatchObject({ dashboardId: savedDashboardId, jsonPointer: "/score", datasetId: "dataset-a", differences: true, sort: "difference", viewMode: "execution" });
    await click(control(screen.container, "打开 零分用例"));
    await waitFor(() => expect(control(screen.container, "项目 1 的有效采样")).not.toBeNull());
    await select(control(screen.container, "项目 1 的有效采样"), "p1-data-0-valid-b");
    await waitFor(() => expect(screen.container.textContent).toContain("p1-data-0-valid-b 的评估理由"));
    main.scrollTop = 260;
    const detailCalls = api.sampling.mock.calls.length;
    await changeView(screen.container, "评估指标");
    expect(main.scrollTop).toBe(260);
    expect((control(screen.container, "共同指标") as HTMLSelectElement).value).toBe("/score");
    expect(screen.router.state.location.search).toMatchObject({ dataId: "data-0", sampling: { p1: "p1-data-0-valid-b" }, datasetId: "dataset-a" });
    expect(control(screen.container, "项目 1 结果")?.textContent).toContain("p1-data-0-valid-b 的评估理由");
    expect(control(screen.container, "项目 1 表现")?.textContent).toContain("0均值");
    expect(api.comparison).toHaveBeenCalledTimes(calls);
    expect(api.sampling).toHaveBeenCalledTimes(detailCalls);
    expect(api.update).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  } finally { await screen.close(); }
});

it("keeps the chosen field and server-projected common Data counts across Dataset, Data, paging and view changes", async () => {
  const base = comparisonView(true);
  const field = { ...base.selectedField!, dataCount: 44 };
  const full: ProjectComparisonView = {
    ...base, selectedField: field, fields: base.fields.map((item) => item.jsonPointer === field.jsonPointer ? field : item),
    datasets: [{ datasetId: "dataset-a", name: "核心任务", dataCount: 31 }, { datasetId: "dataset-b", name: "边界场景", dataCount: 21 }],
    summary: base.summary.map((value) => ({ ...value, dataCount: 44, samplingCount: 88, evaluationCount: 88, score: comparisonScore(false, 88) })),
    rows: Array.from({ length: 44 }, (_, index) => ({
      ...comparisonRow(index, true), datasetIds: index < 8 ? ["dataset-a", "dataset-b"] : index < 31 ? ["dataset-a"] : ["dataset-b"],
    })),
  };
  const scoped: ProjectComparisonView = {
    ...full, datasetId: "dataset-a", rows: full.rows.filter((row) => row.datasetIds.includes("dataset-a")),
    summary: full.summary.map((value) => ({ ...value, dataCount: 31, samplingCount: 62, evaluationCount: 62, score: comparisonScore(false, 62) })),
  };
  api.comparison.mockImplementation(async (query: ProjectComparisonQuery) =>
    query.jsonPointer === "/passed" ? query.datasetId ? scoped : full : comparisonView());
  const screen = await mount(`/dashboard?${new URLSearchParams({ dashboardId: savedDashboardId, jsonPointer: "/score" })}`);
  const scope = () => control(screen.container, "当前共同数据范围")?.textContent;
  const dataRows = () => control(screen.container, "逐条数据对比")?.querySelectorAll("tbody tr");
  try {
    await waitFor(() => expect(control(screen.container, "共同指标")).not.toBeNull());
    await select(control(screen.container, "共同指标"), "/passed");
    await waitFor(() => expect(scope()).toContain("44 条共同已评数据"));
    expect(scope()).toContain("全部共同数据");
    expect(dataRows()).toHaveLength(20);
    await click(button(control(screen.container, "共同数据分页")!, "下一页"));
    expect(dataRows()).toHaveLength(20);
    expect(scope()).toContain("44 条共同已评数据");
    await click(control(screen.container, "范围 核心任务"));
    await waitFor(() => expect(scope()).toContain("31 条共同已评数据"));
    expect(scope()).toContain("核心任务");
    expect(dataRows()).toHaveLength(20);
    await type(control(screen.container, "搜索共同数据"), "零分用例");
    expect(dataRows()).toHaveLength(1);
    expect(scope()).toContain("31 条共同已评数据");
    await click(control(screen.container, "打开 零分用例"));
    await waitFor(() => expect(scope()).toContain("1 条共同已评数据"));
    expect(scope()).toContain("零分用例");
    await waitFor(() => expect(control(screen.container, "项目 1 的有效采样")).not.toBeNull());
    await select(control(screen.container, "项目 1 的有效采样"), "p1-data-0-valid-b");
    await waitFor(() => expect(screen.container.textContent).toContain("p1-data-0-valid-b 的评估理由"));
    const comparisonCalls = api.comparison.mock.calls.length;
    const samplingCalls = api.sampling.mock.calls.length;
    const reading = { dashboardId: savedDashboardId, jsonPointer: "/passed", datasetId: "dataset-a", dataId: "data-0", dataSearch: "零分用例", sampling: { p1: "p1-data-0-valid-b" } };
    await changeView(screen.container, "执行指标");
    expect(control(screen.container, "共同指标")).toBeNull();
    expect(scope()).toContain("1 条共同已评数据");
    expect(screen.router.state.location.search).toMatchObject({ ...reading, viewMode: "execution" });
    await changeView(screen.container, "评估指标");
    expect((control(screen.container, "共同指标") as HTMLSelectElement).value).toBe("/passed");
    expect(scope()).toContain("1 条共同已评数据");
    expect(screen.router.state.location.search).toMatchObject(reading);
    expect(api.comparison).toHaveBeenCalledTimes(comparisonCalls);
    expect(api.sampling).toHaveBeenCalledTimes(samplingCalls);
    expect(api.update).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  } finally { await screen.close(); }
});

it("renders a searchable saved directory in pages of twenty and can return from an unavailable Dashboard", async () => {
  api.list.mockResolvedValue(Array.from({ length: 22 }, (_, index) => savedDashboard({
    dashboardId: `71000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, name: `看板 ${index + 1}`,
  })));
  const screen = await mount();
  try {
    await waitFor(() => expect(screen.container.querySelectorAll("tbody tr")).toHaveLength(20));
    await click(button(screen.container, "下一页"));
    expect(screen.container.querySelectorAll("tbody tr")).toHaveLength(2);
    await type(control(screen.container, "搜索看板名称或说明"), "看板 22");
    expect(screen.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(screen.router.state.location.search.dashboardPage).toBeUndefined();
  } finally { await screen.close(); }
  api.detail.mockRejectedValue(new ApiError({ status: 404, code: "DASHBOARD_NOT_FOUND", message: "看板不存在" }));
  const missing = await mount(`/dashboard?dashboardId=${savedDashboardId}`);
  try {
    await waitFor(() => expect(missing.container.textContent).toContain("无法打开看板"));
    await click(link(missing.container, "返回看板列表"));
    await waitFor(() => expect(control(missing.container, "搜索看板名称或说明")).not.toBeNull());
    expect(missing.router.state.location.search.dashboardId).toBeUndefined();
  } finally { await missing.close(); }
});

it("repairs a saved reference to a deleted Project through an explicit edit and save", async () => {
  let current = savedDashboard();
  api.detail.mockImplementation(async () => current);
  api.projects.mockResolvedValue([comparisonProject(1), comparisonProject(3)]);
  api.comparison.mockImplementation(async (query) => {
    if (query.projectIds.includes("p2")) throw new ApiError({ status: 404, code: "PROJECT_NOT_FOUND", message: "引用项目已删除" });
    return comparisonView();
  });
  api.update.mockImplementation(async (id, input) => {
    current = savedDashboard({ ...input, dashboardId: id, description: input.description ?? "", revision: input.revision + 1 });
    return current;
  });
  const screen = await mount(`/dashboard?dashboardId=${savedDashboardId}&jsonPointer=/score`);
  try {
    await waitFor(() => expect(screen.container.textContent).toContain("如果引用的项目已被删除"));
    await click(link(screen.container, "编辑看板"));
    await waitFor(() => expect(control(screen.container, "移除 p2")).not.toBeNull());
    await click(control(screen.container, "移除 p2"));
    await click(control(screen.container, "选择 项目 3"));
    expect(api.update).not.toHaveBeenCalled();
    await click(button(screen.container, "保存看板"));
    await waitFor(() => expect(screen.container.textContent).toContain("整体差异"));
    expect(api.update.mock.calls[0][1].projectIds).toEqual(["p1", "p3"]);
    expect(api.comparison).toHaveBeenLastCalledWith(expect.objectContaining({ projectIds: ["p1", "p3"] }), expect.any(AbortSignal));
  } finally { await screen.close(); }
});

it("opens saved names and pure navigation as native links without row clicks hijacking modified or keyboard activation", async () => {
  api.list.mockResolvedValue([savedDashboard()]);
  const screen = await mount();
  const nativeClicks: boolean[] = [];
  const preventNavigation = (event: MouseEvent) => {
    nativeClicks.push(!event.defaultPrevented);
    event.preventDefault();
  };
  document.addEventListener("click", preventNavigation);
  try {
    await waitFor(() => expect(link(screen.container, "质量观察")).toBeDefined());
    expect(link(screen.container, "新建看板")).toBeDefined();
    const name = link(screen.container, "质量观察")!;
    await act(async () => { name.focus(); });
    expect(document.activeElement).toBe(name);
    const historyLength = screen.router.history.length;
    for (const options of [{ ctrlKey: true }, { metaKey: true }]) {
      await act(async () => { name.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...options })); });
      expect(screen.router.history.length).toBe(historyLength);
      expect(api.detail).not.toHaveBeenCalled();
    }
    expect(nativeClicks).toEqual([true, true]);
    await act(async () => { name.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 })); });
    await waitFor(() => expect(screen.container.textContent).toContain("整体差异"));
    expect(screen.router.history.length).toBe(historyLength + 1);
    expect(nativeClicks).toEqual([true, true, false]);
    expect(link(screen.container, "看板列表")).toBeDefined();
    expect(link(screen.container, "编辑看板")).toBeDefined();
    expect(link(screen.container, "已选 2 个项目")).toBeDefined();
    await click(link(screen.container, "已选 2 个项目"));
    await waitFor(() => expect(control(screen.container, "看板名称")).not.toBeNull());
    expect(screen.router.state.location.pathname).toBe("/dashboard/edit");
    expect(api.update).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener("click", preventNavigation);
    await screen.close();
  }
});

it("restores the same sorted directory page through open, Back and a shared URL, and resets its page in one sorting navigation", async () => {
  const records = Array.from({ length: 22 }, (_, index) => savedDashboard({
    dashboardId: `71000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `看板 ${String(index + 1).padStart(2, "0")}`,
    updatedAt: `2026-10-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
  }));
  api.list.mockResolvedValue(records.toReversed());
  api.detail.mockImplementation(async (id) => {
    const record = records.find((record) => record.dashboardId === id);
    if (!record) throw new Error("Unknown test Dashboard");
    return record;
  });
  const names = (container: ParentNode) => [...container.querySelectorAll("tbody tr")].map((row) => row.querySelector("td")?.textContent);
  const screen = await mount();
  let shared = "";
  try {
    await waitFor(() => expect(screen.container.querySelectorAll("tbody tr")).toHaveLength(20));
    await click(button(screen.container, "看板"));
    expect(screen.router.state.location.search.dashboardSort).toEqual([{ id: "name", desc: false }]);
    expect(names(screen.container)).toEqual(records.slice(0, 20).map((record) => `${record.name}${record.description}`));
    await click(button(screen.container, "下一页"));
    const expected = records.slice(20).map((record) => `${record.name}${record.description}`);
    expect(names(screen.container)).toEqual(expected);
    shared = screen.router.state.location.href;
    await click(link(screen.container, "看板 21"));
    await waitFor(() => expect(screen.container.textContent).toContain("整体差异"));
    await act(async () => { screen.router.history.back(); });
    await waitFor(() => expect(screen.container.querySelectorAll("tbody tr")).toHaveLength(2));
    expect(names(screen.container)).toEqual(expected);
    expect(screen.router.state.location.href).toBe(shared);
    expect(screen.container.querySelector('th[aria-sort="ascending"]')?.textContent).toBe("看板");
  } finally { await screen.close(); }
  const reopened = await mount(shared);
  try {
    await waitFor(() => expect(reopened.container.querySelectorAll("tbody tr")).toHaveLength(2));
    expect(names(reopened.container)).toEqual(records.slice(20).map((record) => `${record.name}${record.description}`));
    const historyLength = reopened.router.history.length;
    await click(button(reopened.container, "看板"));
    await waitFor(() => expect(reopened.router.state.location.search.dashboardSort).toEqual([{ id: "name", desc: true }]));
    expect(reopened.router.state.location.search.dashboardPage).toBeUndefined();
    expect(reopened.router.history.length).toBe(historyLength + 1);
    expect(names(reopened.container)).toEqual(records.toReversed().slice(0, 20).map((record) => `${record.name}${record.description}`));
    expect(reopened.container.querySelector('th[aria-sort="descending"]')?.textContent).toBe("看板");
    await click(button(reopened.container, "看板"));
    expect(reopened.router.state.location.search.dashboardSort).toBeUndefined();
    expect(api.comparison.mock.calls.every(([query]) => !("dashboardSort" in query))).toBe(true);
    expect(api.create).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
  } finally { await reopened.close(); }
});

it("retains multi-column directory sorting, including its direction, after reopening the URL", async () => {
  const records = [
    savedDashboard({ dashboardId: "71000000-0000-4000-8000-000000000011", name: "A", updatedAt: "2026-10-01T10:00:00Z" }),
    savedDashboard({ dashboardId: "71000000-0000-4000-8000-000000000012", name: "A", updatedAt: "2026-10-02T10:00:00Z" }),
    savedDashboard({ dashboardId: "71000000-0000-4000-8000-000000000013", name: "B", updatedAt: "2026-10-03T10:00:00Z" }),
  ];
  api.list.mockResolvedValue(records.toReversed());
  const ids = (container: ParentNode) => [...container.querySelectorAll<HTMLAnchorElement>("tbody a")].map((node) =>
    new URL(node.href).searchParams.get("dashboardId"));
  const screen = await mount();
  let shared = "";
  try {
    await waitFor(() => expect(button(screen.container, "看板")).toBeDefined());
    await click(button(screen.container, "看板"));
    await act(async () => { button(screen.container, "更新时间")!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })); });
    expect(screen.router.state.location.search.dashboardSort).toEqual([{ id: "name", desc: false }, { id: "updated", desc: false }]);
    expect(ids(screen.container)).toEqual(records.map((record) => record.dashboardId));
    await act(async () => { button(screen.container, "更新时间")!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })); });
    expect(screen.router.state.location.search.dashboardSort).toEqual([{ id: "name", desc: false }, { id: "updated", desc: true }]);
    expect(ids(screen.container)).toEqual([records[1].dashboardId, records[0].dashboardId, records[2].dashboardId]);
    shared = screen.router.state.location.href;
  } finally { await screen.close(); }
  const reopened = await mount(shared);
  try {
    await waitFor(() => expect(reopened.container.querySelectorAll("tbody tr")).toHaveLength(3));
    expect(ids(reopened.container)).toEqual([records[1].dashboardId, records[0].dashboardId, records[2].dashboardId]);
    expect(api.create).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
  } finally { await reopened.close(); }
});

it.each([
  { input: "name", expected: undefined },
  { input: [{ id: "score", desc: false }, { id: "name", desc: "true" }], expected: undefined },
  { input: [{ id: "updated" }], expected: undefined },
  { input: [{ id: "updated", desc: true }, { id: "updated", desc: false }, { id: "name", desc: false, extra: "discard" }], expected: [{ id: "updated", desc: true }, { id: "name", desc: false }] },
])("cleans invalid directory sorting out of the actual URL without creating history entries: $input", async ({ input, expected }) => {
  api.list.mockResolvedValue([
    savedDashboard({ name: "A", updatedAt: "2026-10-01T10:00:00Z" }),
    savedDashboard({ dashboardId: "71000000-0000-4000-8000-000000000002", name: "B", updatedAt: "2026-10-02T10:00:00Z" }),
  ]);
  const screen = await mount(`/dashboard?${new URLSearchParams({ dashboardSort: JSON.stringify(input) })}`);
  try {
    await waitFor(() => {
      expect(screen.container.querySelectorAll("tbody tr")).toHaveLength(2);
      expect(new URLSearchParams(screen.router.state.location.searchStr).get("dashboardSort")).toBe(expected ? JSON.stringify(expected) : null);
    });
    expect(screen.router.state.location.search.dashboardSort).toEqual(expected);
    expect(screen.router.history.length).toBe(1);
    expect(screen.container.querySelector("tbody td")?.textContent).toBe(`${expected ? "B" : "A"}当前共同已评数据`);
    expect(api.comparison).not.toHaveBeenCalled();
  } finally { await screen.close(); }
});
