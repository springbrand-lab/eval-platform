import { focusManager, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act, useLayoutEffect, useRef } from "react";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { projectKeys } from "@/api-sdk/projects-api";
import { comparisonKeys, getProjectComparison } from "@/api-sdk/comparison-api";
import type { ComparisonField, Dashboard, DashboardCreateInput, DashboardUpdateInput, OutputFieldSummary, ProjectComparisonQuery, ProjectComparisonView } from "@/api-sdk/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { comparisonProject, comparisonProjectView, comparisonRow, comparisonSampling, comparisonScore, comparisonView, savedDashboard, savedDashboardId } from "@/test/comparison";
import { inputLimits } from "@/test/input-limits";
import { click, render, select, type } from "@/test/render";
import { refreshProjectResults } from "@/features/projects/use-project";
import { POLL_MS } from "@/features/runs/use-run-polling";
import { DashboardPage } from "./dashboard-page";
import { EditDashboardPage, NewDashboardPage } from "./dashboard-form-page";
import { dashboardEditSearchMiddleware, dashboardSearchMiddleware, validateDashboardEditSearch, validateDashboardReadSearch, type DashboardReadSearch } from "./dashboard-search";

const reads = vi.hoisted(() => ({
  projects: vi.fn(), limits: vi.fn(), comparison: vi.fn(), project: vi.fn(), sampling: vi.fn(), file: vi.fn(),
  dashboard: vi.fn(), dashboards: vi.fn(), createDashboard: vi.fn(), updateDashboard: vi.fn(),
}));
vi.mock("@/api-sdk/dashboards-api", async (original) => ({
  ...await original<object>(), getDashboard: reads.dashboard, listDashboards: reads.dashboards, createDashboard: reads.createDashboard, updateDashboard: reads.updateDashboard,
}));
vi.mock("@/api-sdk/projects-api", async (original) => ({ ...await original<object>(), listProjects: reads.projects, getProject: reads.project }));
vi.mock("@/api-sdk/input-limits-api", async (original) => ({ ...await original<object>(), getInputLimits: reads.limits }));
vi.mock("@/api-sdk/comparison-api", async (original) => ({ ...await original<object>(), getProjectComparison: reads.comparison }));
vi.mock("@/api-sdk/metrics-api", async (original) => ({ ...await original<object>(), getSamplingDetail: reads.sampling }));
vi.mock("@/api-sdk/runs-api", async (original) => ({ ...await original<object>(), listSamplingEvaluations: async () => [] }));
vi.mock("@/api-sdk/observations-api", async (original) => ({ ...await original<object>(), getWorkspaceFile: reads.file }));
vi.mock("@/components/files/file-preview", () => ({
  FilePreview: ({ file, readFile }: { file: { path: string }; readFile: (path: string, signal: AbortSignal) => Promise<Blob> }) =>
    <button onClick={() => void readFile(file.path, new AbortController().signal)}>打开产物 {file.path}</button>,
}));
vi.mock("@/features/observation/messages-tab", () => ({ MessagesTab: () => <div>只读会话</div> }));
vi.mock("@/features/observation/trajectory-tab", () => ({ TrajectoryTab: () => <div>只读轨迹</div> }));

beforeAll(async () => { await import("@/features/results/sampling-detail-page"); });

const secondaryDashboardId = "71000000-0000-4000-8000-000000000002";
let records: Map<string, Dashboard>;
beforeEach(() => {
  vi.clearAllMocks();
  reads.projects.mockResolvedValue(Array.from({ length: 22 }, (_, index) => comparisonProject(index + 1)));
  reads.limits.mockResolvedValue(inputLimits);
  reads.comparison.mockResolvedValue(comparisonView());
  reads.project.mockImplementation(async (projectId: string) => comparisonProjectView(projectId));
  reads.sampling.mockImplementation(async (projectId: string, samplingId: string) => comparisonSampling(projectId, samplingId));
  reads.file.mockResolvedValue(new Blob(["artifact"]));
  records = new Map([
    [savedDashboardId, savedDashboard()],
    [secondaryDashboardId, savedDashboard({ dashboardId: secondaryDashboardId, projectIds: ["p3", "p4"] })],
  ]);
  reads.dashboard.mockImplementation(async (id: string) => records.get(id));
  reads.dashboards.mockImplementation(async () => [...records.values()]);
  reads.createDashboard.mockImplementation(async (input: DashboardCreateInput) => {
    const value = savedDashboard({ ...input, description: input.description ?? "" });
    records.set(value.dashboardId, value);
    return value;
  });
  reads.updateDashboard.mockImplementation(async (id: string, input: DashboardUpdateInput) => {
    const value = savedDashboard({ ...input, dashboardId: id, description: input.description ?? "", revision: input.revision + 1 });
    records.set(id, value);
    return value;
  });
  window.scrollTo = vi.fn();
});

const button = (container: ParentNode, text: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === text);
const link = (container: ParentNode, text: string) => [...container.querySelectorAll<HTMLAnchorElement>("a[href]")].find((item) => item.textContent === text);
const control = (container: ParentNode, label: string) => container.querySelector(`[aria-label="${label}"]`);
const comparePath = (extra: Record<string, string> = {}) => `/dashboard?${new URLSearchParams({ dashboardId: savedDashboardId, ...extra })}`;
function executionValues(container: ParentNode) {
  const metrics = control(container, "执行 Agent 指标");
  expect(metrics).not.toBeNull();
  return Object.fromEntries([...metrics!.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]));
}
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

async function mount(path = "/dashboard/new", cached = false, redirectOnComparison?: DashboardReadSearch & { edit?: boolean }) {
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => root, path: "/dashboard", validateSearch: validateDashboardReadSearch, search: { middlewares: [dashboardSearchMiddleware] },
    component: () => <><DashboardPage search={route.useSearch()} />{redirectOnComparison && <RedirectBeforeDefaultMetric />}</>,
  });
  const create = createRoute({
    getParentRoute: () => root, path: "/dashboard/new", validateSearch: validateDashboardReadSearch, search: { middlewares: [dashboardSearchMiddleware] },
    component: () => <NewDashboardPage search={create.useSearch()} />,
  });
  const edit = createRoute({
    getParentRoute: () => root, path: "/dashboard/edit", validateSearch: validateDashboardEditSearch, search: { middlewares: [dashboardEditSearchMiddleware] },
    component: () => <EditDashboardPage search={edit.useSearch()} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([route, create, edit]), history: createMemoryHistory({ initialEntries: [path] }),
    defaultPendingMinMs: 0,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  function RedirectBeforeDefaultMetric() {
    const query = { projectIds: ["p1", "p2"] };
    const comparison = useQuery({ queryKey: comparisonKeys.view(query), queryFn: ({ signal }) => getProjectComparison(query, signal), enabled: false });
    const redirected = useRef(false);
    useLayoutEffect(() => {
      if (comparison.data && redirectOnComparison && !redirected.current) {
        redirected.current = true;
        void router.navigate({ to: redirectOnComparison.edit ? "/dashboard/edit" : "/dashboard", search: validateDashboardReadSearch({ ...redirectOnComparison }) });
      }
    }, [comparison.data]);
    return null;
  }
  if (cached) client.setQueryData(projectKeys.list(), Array.from({ length: 22 }, (_, index) => comparisonProject(index + 1)));
  const screen = await render(<TooltipProvider><QueryClientProvider client={client}><main><RouterProvider router={router} /></main></QueryClientProvider></TooltipProvider>);
  await act(async () => { await router.load(); });
  return { ...screen, router, client, close: async () => { await screen.unmount(); client.clear(); } };
}

it("creates a named dashboard from a cached searchable Project table and keeps selections across twenty-row pages", async () => {
  const screen = await mount("/dashboard/new", true);
  try {
    await waitFor(() => expect(control(screen.container, "选择 项目 1")).not.toBeNull());
    expect(screen.container.querySelectorAll("tbody tr")).toHaveLength(20);
    expect(reads.projects).not.toHaveBeenCalled();
    await type(control(screen.container, "看板名称"), "质量观察");
    expect(button(screen.container, "创建看板")?.disabled).toBe(true);
    await click(control(screen.container, "选择 项目 1"));
    expect(button(screen.container, "创建看板")?.disabled).toBe(true);
    await click(button(screen.container, "下一页"));
    await click(control(screen.container, "选择 项目 21"));
    await click(button(screen.container, "上一页"));
    expect(control(screen.container, "选择 项目 1")?.getAttribute("aria-checked")).toBe("true");
    expect(control(screen.container, "已选项目")?.textContent).toContain("项目 21");
    await type(control(screen.container, "搜索对比项目"), "项目 2");
    expect(screen.router.state.location.search.projectSearch).toBe("项目 2");
    await click(control(screen.container, "移除 项目 21"));
    await click(control(screen.container, "选择 项目 2"));
    await click(button(screen.container, "创建看板"));
    await waitFor(() => expect(screen.container.textContent).toContain("整体差异"));
    expect(reads.comparison).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ["p1", "p2"] }), expect.any(AbortSignal));
    expect(screen.container.textContent).toContain("7.25");
    expect(screen.container.textContent).toContain("8.5");
    expect(screen.container.textContent).not.toContain("赢家");
    expect(screen.container.textContent).not.toContain("基线项目");
    expect(screen.router.state.location.search.dashboardId).toBe(savedDashboardId);
    expect(reads.createDashboard.mock.calls[0][0].projectIds).toEqual(["p1", "p2"]);
  } finally { await screen.close(); }
});

it("shows execution cache and tool rates without expanding overview resource details", async () => {
  const full = comparisonView();
  const view: ProjectComparisonView = {
    ...full,
    summary: full.summary.map((value) => ({
      ...value,
      resources: {
        ...value.resources,
        cacheHitRate: { value: 0.25, coverage: "complete" },
        toolSuccessRate: { value: 0.9, coverage: "partial" },
      },
    })),
  };
  reads.comparison.mockResolvedValue(view);
  const screen = await mount(comparePath({ jsonPointer: "/score" }));
  try {
    await waitFor(() => expect(control(screen.container, "项目 1 表现")).not.toBeNull());
    expect(control(screen.container, "项目 1 表现")?.querySelector('dl[aria-label="执行 Agent 指标"]')).toBeNull();
    await changeView(screen.container, "执行指标");
    const section = control(screen.container, "项目 1 表现")!;
    const cache = [...section.querySelectorAll("dt")].find((term) => term.textContent === "缓存命中率")!;
    const tools = [...section.querySelectorAll("dt")].find((term) => term.textContent === "工具调用成功率")!;
    expect(cache.nextElementSibling?.textContent).toBe("25.0%");
    expect(tools.nextElementSibling?.textContent).toBe("90.0% · 部分");
    expect(cache.closest("details")).toBeNull();
    expect(tools.closest("details")).toBeNull();
    expect([...section.querySelectorAll("dt")].find((term) => term.textContent === "平均执行积分")).toBeDefined();
    expect([...section.querySelectorAll("dt")].find((term) => term.textContent === "平均执行耗时")).toBeDefined();
  } finally { await screen.close(); }
});

it("shows the current Data's execution measurements per Project without replacing missing resources with zero", async () => {
  const full = comparisonView();
  const first = full.rows[0];
  const view: ProjectComparisonView = {
    ...full,
    rows: [{
      ...first,
      projects: first.projects.map((value, index) => ({
        ...value,
        resources: {
          ...value.resources,
          chargedUnitsPerAgent: { ...value.resources.chargedUnitsPerAgent, mean: index === 0 ? 2.75 : null, coverage: index === 0 ? "partial" : "unavailable" },
          agentDurationMs: { ...value.resources.agentDurationMs, mean: index === 0 ? 1_234 : null, count: index === 0 ? 2 : 0, missing: index === 0 ? 0 : 2 },
          cacheHitRate: index === 0 ? { value: 0, coverage: "complete" } : { value: null, coverage: "unavailable" },
          toolSuccessRate: index === 0 ? { value: 0.8, coverage: "partial" } : { value: null, coverage: "complete" },
        },
      })),
    }],
  };
  reads.comparison.mockResolvedValue(view);
  const screen = await mount(comparePath({ jsonPointer: "/score" }));
  try {
    await waitFor(() => expect(screen.container.querySelector('table[aria-label="逐条数据对比"] tbody tr')).not.toBeNull());
    await changeView(screen.container, "执行指标");
    const cells = screen.container.querySelector('table[aria-label="逐条数据对比"] tbody tr')!.querySelectorAll("td");
    expect(executionValues(cells[2])).toEqual({
      "平均执行积分": "2.75 · 部分", "平均执行耗时": "1.2 秒", "缓存命中率": "0%", "工具调用成功率": "80.0% · 部分",
    });
    expect(executionValues(cells[3])).toEqual({
      "平均执行积分": "未获得", "平均执行耗时": "未获得", "缓存命中率": "未获得", "工具调用成功率": "—",
    });
    expect(control(screen.container, "当前范围表现")?.textContent).toContain("24条共同已评数据");
  } finally { await screen.close(); }
});

it("shows each selected Sampling's own execution metrics and updates them independently without evaluator consumption", async () => {
  reads.sampling.mockImplementation(async (projectId: string, samplingId: string) => {
    const detail = comparisonSampling(projectId, samplingId);
    const second = samplingId.endsWith("-valid-b");
    const chargedUnits = projectId === "p2" ? 29 : second ? 0 : 17;
    return {
      ...detail,
      subject: {
        ...detail.subject,
        agentDurationMs: projectId === "p2" ? 8_000 : second ? 0 : 3_500,
        resources: {
          ...detail.subject.resources,
          costs: { ...detail.subject.resources.costs, chargedUnits: { value: chargedUnits, coverage: "complete" } },
          cacheHitRate: projectId === "p2" ? { value: null, coverage: "unavailable" } : { value: second ? 0 : 0.2, coverage: second ? "complete" : "partial" },
          trajectory: { ...detail.subject.resources.trajectory, toolSuccessRate: { value: projectId === "p2" ? 1 : second ? null : 0.5, coverage: "complete" } },
        },
      },
      evaluations: detail.evaluations.map((evaluation) => ({
        ...evaluation,
        agent: {
          ...evaluation.agent, agentDurationMs: 999_000,
          resources: {
            ...evaluation.agent.resources,
            costs: { ...evaluation.agent.resources.costs, chargedUnits: { value: 999, coverage: "complete" } },
            cacheHitRate: { value: 0.99, coverage: "complete" },
            trajectory: { ...evaluation.agent.resources.trajectory, toolSuccessRate: { value: 0.99, coverage: "complete" } },
          },
        },
      })),
    };
  });
  const screen = await mount(comparePath({ jsonPointer: "/score", dataId: "data-0" }));
  const metrics = (name: string) => control(control(screen.container, name)!, "当前采样执行 Agent 指标");
  try {
    await waitFor(() => expect(control(screen.container, "项目 1 的有效采样")).not.toBeNull());
    await changeView(screen.container, "执行指标");
    await waitFor(() => expect(metrics("项目 1 结果")).not.toBeNull());
    await waitFor(() => expect(metrics("项目 2 结果")).not.toBeNull());
    expect(executionValues(metrics("项目 1 结果")!)).toEqual({
      "实际执行积分": "17", "实际执行耗时": "3.5 秒", "缓存命中率": "20.0% · 部分", "工具调用成功率": "50.0%",
    });
    expect(executionValues(metrics("项目 2 结果")!)).toEqual({
      "实际执行积分": "29", "实际执行耗时": "8.0 秒", "缓存命中率": "未获得", "工具调用成功率": "100%",
    });
    await select(control(screen.container, "项目 1 的有效采样"), "p1-data-0-valid-b");
    await waitFor(() => expect(executionValues(metrics("项目 1 结果")!)["实际执行积分"]).toBe("0"));
    expect(executionValues(metrics("项目 1 结果")!)).toEqual({
      "实际执行积分": "0", "实际执行耗时": "0 毫秒", "缓存命中率": "0%", "工具调用成功率": "—",
    });
    expect(executionValues(metrics("项目 2 结果")!)["实际执行积分"]).toBe("29");
    expect(control(screen.container, "当前范围表现")?.textContent).toContain("平均执行积分0.75");
    expect(metrics("项目 1 结果")?.textContent).not.toContain("999");
    expect(metrics("项目 2 结果")?.textContent).not.toContain("99.0%");
  } finally { await screen.close(); }
});

it("walks from Projects through a metric and Dataset to a Data's authoritative values and independent valid Sampling results", async () => {
  const full = comparisonView();
  const scoped: ProjectComparisonView = {
    ...full, datasetId: "dataset-b", rows: [full.rows[0]],
    summary: full.summary.map((value) => ({ ...value, dataCount: 1, score: comparisonScore(9.1, 2) })),
  };
  reads.comparison.mockImplementation(async (query: ProjectComparisonQuery) =>
    query.jsonPointer === "/passed" ? comparisonView(true) : query.datasetId ? scoped : full);
  const screen = await mount();
  try {
    await waitFor(() => expect(control(screen.container, "选择 项目 1")).not.toBeNull());
    await type(control(screen.container, "看板名称"), "质量观察");
    await click(control(screen.container, "选择 项目 1"));
    await click(control(screen.container, "选择 项目 2"));
    await click(button(screen.container, "创建看板"));
    await waitFor(() => expect(control(screen.container, "共同指标")).not.toBeNull());
    expect(screen.container.querySelectorAll('table[aria-label="逐条数据对比"] tbody tr')).toHaveLength(20);
    expect(control(screen.container, "范围 全部共同数据")?.textContent).toContain("24");
    expect(control(screen.container, "当前范围表现")?.textContent).toContain("24条共同已评数据");
    expect(control(screen.container, "切换范围和数据导航")?.getAttribute("aria-expanded")).toBe("false");
    await click(control(screen.container, "切换范围和数据导航"));
    expect(control(screen.container, "切换范围和数据导航")?.getAttribute("aria-expanded")).toBe("true");
    await click(control(screen.container, "范围 边界场景"));
    await waitFor(() => expect(control(screen.container, "当前范围表现")?.textContent).toContain("9.1"));
    expect(control(screen.container, "切换范围和数据导航")?.getAttribute("aria-expanded")).toBe("false");
    expect(reads.comparison).toHaveBeenLastCalledWith(expect.objectContaining({ datasetId: "dataset-b", jsonPointer: "/score" }), expect.any(AbortSignal));
    const requests = reads.comparison.mock.calls.length;
    await click(control(screen.container, "打开 零分用例"));
    await waitFor(() => expect(screen.container.textContent).toContain("p1-data-0-valid-a 的评估理由"));
    await waitFor(() => expect(screen.container.textContent).toContain("p2-data-0-valid-a 的评估理由"));
    expect(reads.comparison).toHaveBeenCalledTimes(requests);
    expect(control(screen.container, "当前范围表现")?.textContent).not.toContain("9.1");
    expect(control(screen.container, "当前范围表现")?.textContent).toContain("0均值");
    expect(screen.container.textContent).toContain("这条数据在各项目中冻结的输入有差异");
    expect(control(screen.container, "共同数据导航")).not.toBeNull();
    expect(control(screen.container, "项目 1 的有效采样")?.querySelectorAll("option")).toHaveLength(2);
    await select(control(screen.container, "项目 1 的有效采样"), "p1-data-0-valid-b");
    await waitFor(() => expect(screen.container.textContent).toContain("p1-data-0-valid-b 的评估理由"));
    expect(screen.container.textContent).toContain("p2-data-0-valid-a 的评估理由");
    expect(screen.router.state.location.search).toMatchObject({
      dashboardId: savedDashboardId, jsonPointer: "/score", datasetId: "dataset-b", dataId: "data-0",
      sampling: { p1: "p1-data-0-valid-b" },
    });
    expect(button(screen.container, "重新执行")).toBeUndefined();
    expect(button(screen.container, "重新评估")).toBeUndefined();
    await click(button(control(screen.container, "项目 1 结果")!, "打开产物 /index.html"));
    expect(reads.file).toHaveBeenLastCalledWith("p1", "samplings", "p1-data-0-valid-b", "/index.html", expect.any(AbortSignal));
    await click(control(screen.container, "返回当前数据集"));
    await waitFor(() => expect(control(screen.container, "打开 零分用例")).not.toBeNull());
    expect(screen.router.state.location.search.datasetId).toBe("dataset-b");
    await select(control(screen.container, "共同指标"), "/passed");
    await waitFor(() => expect(control(screen.container, "当前范围表现")?.textContent).toContain("否 100%"));
    expect(screen.router.state.location.search.datasetId).toBeUndefined();
    expect(screen.router.state.location.search.dataId).toBeUndefined();
    expect(control(screen.container, "当前范围表现")?.textContent).toContain("1条共同已评数据");
  } finally { await screen.close(); }
});

it("blocks fewer than two or over-limit selections, and retries a failed server-owned limit instead of allowing unlimited selection", async () => {
  reads.limits.mockRejectedValueOnce(new Error("上限读取暂时失败"));
  const screen = await mount();
  try {
    await waitFor(() => expect(screen.container.textContent).toContain("上限读取暂时失败"));
    expect(reads.comparison).not.toHaveBeenCalled();
    expect(control(screen.container, "选择 项目 1")).toBeNull();
    await click(button(screen.container, "重试"));
    await waitFor(() => expect(control(screen.container, "选择 项目 1")).not.toBeNull());
    await type(control(screen.container, "看板名称"), "上限验证");
    await click(control(screen.container, "选择 项目 1"));
    expect(button(screen.container, "创建看板")?.disabled).toBe(true);
    for (const index of [2, 3, 4]) await click(control(screen.container, `选择 项目 ${index}`));
    for (const index of [1, 2, 3]) expect(control(screen.container, `选择 项目 ${index}`)?.getAttribute("aria-checked")).toBe("true");
    expect(reads.createDashboard).not.toHaveBeenCalled();
    expect(screen.container.textContent).toContain(`本次最多选择 ${inputLimits.comparisonProjects} 个项目`);
    expect(control(screen.container, "选择 项目 4")?.getAttribute("aria-checked")).toBe("false");
  } finally { await screen.close(); }
});

it("has a clear scored-intersection empty state and preserves the selected Projects when a comparison read needs retry", async () => {
  reads.comparison.mockRejectedValueOnce(new Error("对比读取暂时失败")).mockResolvedValue({
    ...comparisonView(), fields: [], selectedField: null, datasets: [], summary: [], rows: [],
  });
  const screen = await mount(comparePath());
  try {
    await waitFor(() => expect(screen.container.textContent).toContain("对比读取暂时失败"));
    await click(button(screen.container, "重试"));
    await waitFor(() => expect(screen.container.textContent).toContain("暂无共同已评数据"));
    expect(screen.container.textContent).toContain("0 和 false");
    expect(screen.container.querySelector("tbody")).toBeNull();
    expect(screen.router.state.location.search.dashboardId).toBe(savedDashboardId);
    await click(link(screen.container, "编辑看板"));
    await waitFor(() => expect(control(screen.container, "选择 项目 1")?.getAttribute("aria-checked")).toBe("true"));
  } finally { await screen.close(); }
});

it("keeps list search, paging, Data and each Project's Sampling in shareable URLs and restores the list with browser Back", async () => {
  const screen = await mount(comparePath({ jsonPointer: "/score" }));
  let shared = "";
  try {
    await waitFor(() => expect(control(screen.container, "共同数据分页")).not.toBeNull());
    await click(button(control(screen.container, "共同数据分页")!, "下一页"));
    expect(screen.router.state.location.search.dataPage).toBe(2);
    expect(screen.container.querySelectorAll('table[aria-label="逐条数据对比"] tbody tr')).toHaveLength(4);
    await type(control(screen.container, "搜索共同数据"), "零分");
    expect(screen.router.state.location.search.dataPage).toBeUndefined();
    expect(screen.container.querySelectorAll('table[aria-label="逐条数据对比"] tbody tr')).toHaveLength(1);
    await click(control(screen.container, "打开 零分用例"));
    await waitFor(() => expect(control(screen.container, "项目 2 的有效采样")).not.toBeNull());
    await select(control(screen.container, "项目 2 的有效采样"), "p2-data-0-valid-b");
    await waitFor(() => expect(screen.container.textContent).toContain("p2-data-0-valid-b 的评估理由"));
    shared = screen.router.state.location.href;
    await act(async () => { screen.router.history.back(); });
    await waitFor(() => expect((control(screen.container, "项目 2 的有效采样") as HTMLSelectElement | null)?.value).toBe("p2-data-0-valid-a"));
    await act(async () => { screen.router.history.back(); });
    await waitFor(() => expect(control(screen.container, "打开 零分用例")).not.toBeNull());
    expect(screen.router.state.location.search.dataSearch).toBe("零分");
    expect(screen.router.state.location.search.dataId).toBeUndefined();
  } finally { await screen.close(); }
  const restored = await mount(shared);
  try {
    await waitFor(() => expect(restored.container.textContent).toContain("p2-data-0-valid-b 的评估理由"));
    expect((control(restored.container, "项目 2 的有效采样") as HTMLSelectElement).value).toBe("p2-data-0-valid-b");
    expect((control(restored.container, "搜索共同数据") as HTMLInputElement).value).toBe("零分");
    expect(restored.router.state.location.search).toMatchObject({ dashboardId: savedDashboardId, jsonPointer: "/score", dataId: "data-0" });
  } finally { await restored.close(); }
});

it("locates differences from the DTO without changing full-range statistics or treating a zero spread as missing", async () => {
  const full = comparisonView();
  reads.comparison.mockResolvedValue({ ...full, rows: full.rows.map((row, index) => ({ ...row, different: index === 0, spread: 0 })) });
  const screen = await mount(comparePath({ jsonPointer: "/score" }));
  try {
    await waitFor(() => expect(control(screen.container, "共同数据分页")).not.toBeNull());
    const checkbox = screen.container.querySelector('[role="checkbox"]');
    await click(checkbox);
    expect(screen.router.state.location.search.differences).toBe(true);
    const rows = screen.container.querySelectorAll('table[aria-label="逐条数据对比"] tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("零分用例");
    expect(rows[0]?.textContent).toContain("幅度 0");
    expect(control(screen.container, "当前范围表现")?.textContent).toContain("7.25");
    expect(control(screen.container, "当前范围表现")?.textContent).toContain("24条共同已评数据");
  } finally { await screen.close(); }
});

it("cancels an old Dataset read and never presents its late response in a newer scope", async () => {
  const full = comparisonView();
  let resolveOld!: (view: ProjectComparisonView) => void;
  let oldSignal: AbortSignal | undefined;
  reads.comparison.mockImplementation((query: ProjectComparisonQuery, signal: AbortSignal) => {
    if (query.datasetId === "dataset-a") {
      oldSignal = signal;
      return new Promise<ProjectComparisonView>((resolve) => { resolveOld = resolve; });
    }
    return Promise.resolve(query.datasetId === "dataset-b" ? {
      ...full, datasetId: "dataset-b", rows: [full.rows[0]],
      summary: full.summary.map((value) => ({ ...value, dataCount: 1, score: comparisonScore(9.1) })),
    } : full);
  });
  const screen = await mount(comparePath({ jsonPointer: "/score" }));
  try {
    await waitFor(() => expect(control(screen.container, "范围 核心任务")).not.toBeNull());
    await click(control(screen.container, "范围 核心任务"));
    await waitFor(() => expect(oldSignal).toBeDefined());
    expect(screen.container.textContent).not.toContain("7.25");
    await act(async () => { screen.router.history.back(); });
    await waitFor(() => expect(control(screen.container, "范围 边界场景")).not.toBeNull());
    expect(oldSignal?.aborted).toBe(true);
    await click(control(screen.container, "范围 边界场景"));
    await waitFor(() => expect(control(screen.container, "当前范围表现")?.textContent).toContain("9.1"));
    await act(async () => { resolveOld({ ...full, datasetId: "dataset-a" }); });
    expect(control(screen.container, "当前范围表现")?.textContent).toContain("9.1");
    expect(screen.router.state.location.search.datasetId).toBe("dataset-b");
    expect(screen.container.querySelectorAll('table[aria-label="逐条数据对比"] tbody tr')).toHaveLength(1);
  } finally { await screen.close(); }
});

it("participates in Project-result refresh, replacing even an uncached in-flight snapshot and leaving unrelated comparisons alone", async () => {
  let resolveOld!: (view: ProjectComparisonView) => void;
  let oldSignal: AbortSignal | undefined;
  reads.comparison.mockImplementationOnce((_query: ProjectComparisonQuery, signal: AbortSignal) => {
    oldSignal = signal;
    return new Promise<ProjectComparisonView>((resolve) => { resolveOld = resolve; });
  }).mockResolvedValue(comparisonView());
  const screen = await mount(comparePath({ jsonPointer: "/score" }));
  const unrelated = comparisonKeys.view({ projectIds: ["p3", "p4"], jsonPointer: "/score" });
  screen.client.setQueryData(unrelated, comparisonView());
  try {
    await waitFor(() => expect(reads.comparison).toHaveBeenCalledTimes(1));
    await act(async () => { await refreshProjectResults(screen.client, "p1"); });
    await waitFor(() => expect(control(screen.container, "当前范围表现")?.textContent).toContain("7.25"));
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.client.getQueryState(unrelated)?.isInvalidated).toBe(false);
    const full = comparisonView();
    await act(async () => { resolveOld({ ...full, summary: full.summary.map((value) => ({ ...value, score: comparisonScore(123.45) })) }); });
    expect(control(screen.container, "当前范围表现")?.textContent).not.toContain("123.45");
  } finally { await screen.close(); }
});

it("shows a scoped empty state without a wall of unscored Project placeholders", async () => {
  const full = comparisonView();
  reads.comparison.mockResolvedValue({
    ...full, datasetId: "dataset-b", rows: [], summary: full.summary.map((value) => ({ ...value, dataCount: 0, score: null })),
  });
  const screen = await mount(comparePath({ jsonPointer: "/score", datasetId: "dataset-b" }));
  try {
    await waitFor(() => expect(screen.container.textContent).toContain("当前范围暂无共同已评数据"));
    expect(control(screen.container, "当前范围表现")).toBeNull();
    expect(screen.container.textContent).not.toContain("无有效评分");
    expect(screen.container.querySelector("tbody")).toBeNull();
  } finally { await screen.close(); }
});

it("polls the current visible scope with the shared interval and pauses in a hidden tab", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  focusManager.setFocused(true);
  const screen = await mount(comparePath({ jsonPointer: "/score", datasetId: "dataset-b" }));
  try {
    await waitFor(() => expect(control(screen.container, "当前范围表现")).not.toBeNull());
    const previous = reads.comparison.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(reads.comparison).toHaveBeenCalledTimes(previous + 1);
    expect(reads.comparison).toHaveBeenLastCalledWith(expect.objectContaining({ projectIds: ["p1", "p2"], datasetId: "dataset-b", jsonPointer: "/score" }), expect.any(AbortSignal));
    focusManager.setFocused(false);
    const visibleReads = reads.comparison.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 2); });
    expect(reads.comparison).toHaveBeenCalledTimes(visibleReads);
  } finally {
    await screen.close();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  }
});

it("removes a selected Project only in an explicit recoverable edit draft", async () => {
  const screen = await mount(comparePath({ jsonPointer: "/score", datasetId: "dataset-b" }));
  try {
    await waitFor(() => expect(control(screen.container, "移除 项目 2")).not.toBeNull());
    await click(control(screen.container, "移除 项目 2"));
    await waitFor(() => expect(control(screen.container, "选择 项目 1")?.getAttribute("aria-checked")).toBe("true"));
    expect(screen.router.state.location.pathname).toBe("/dashboard/edit");
    expect(records.get(savedDashboardId)?.projectIds).toEqual(["p1", "p2"]);
    expect(reads.updateDashboard).not.toHaveBeenCalled();
    expect(screen.router.state.location.search.datasetId).toBe("dataset-b");
    expect(screen.router.state.location.search.jsonPointer).toBe("/score");
    expect(button(screen.container, "保存看板")?.disabled).toBe(true);
    expect(control(screen.container, "选择 项目 2")?.getAttribute("aria-checked")).toBe("false");
  } finally { await screen.close(); }
});

it("does not use an obsolete Sampling from a shared URL or silently switch an absent Data to another row", async () => {
  const screen = await mount(comparePath({ jsonPointer: "/score", dataId: "data-0", sampling: '{"p1":"old-sampling"}' }));
  try {
    await waitFor(() => expect(screen.container.textContent).toContain("p1-data-0-valid-a 的评估理由"));
    expect(screen.container.textContent).toContain("此前选择已不在当前有效采样范围");
    expect(reads.sampling.mock.calls.some((call) => call[1] === "old-sampling")).toBe(false);
    await act(async () => {
      await screen.router.navigate({ to: "/dashboard", search: { dashboardId: savedDashboardId, jsonPointer: "/score", dataId: "removed-data" } });
    });
    await waitFor(() => expect(screen.container.textContent).toContain("这条数据已不在当前共同已评范围"));
    expect(control(screen.container, "当前范围表现")).toBeNull();
    expect(control(screen.container, "共同数据导航")).not.toBeNull();
  } finally { await screen.close(); }
});

it("compares source-provided mean execution credits, retains totals and valid counts, and names each evaluation Agent", async () => {
  const full = comparisonView();
  reads.comparison.mockResolvedValue({
    ...full,
    projects: full.projects.map((project, index) => ({ ...project, evaluationAgentName: index === 0 ? "严谨评估配置" : "简洁评估配置" })),
    summary: full.summary.map((value, index) => ({
      ...value, samplingCount: index === 0 ? 4 : 12, evaluationCount: index === 0 ? 3 : 11,
      resources: {
        ...value.resources,
        chargedUnits: { value: index === 0 ? 140 : 210, coverage: "complete" },
        chargedUnitsPerAgent: { ...value.resources.chargedUnitsPerAgent, mean: index === 0 ? 2.75 : 0, coverage: index === 0 ? "partial" : "complete" },
      },
    })),
  });
  const screen = await mount(comparePath({ jsonPointer: "/score" }));
  const metric = (section: Element, label: string) => [...section.querySelectorAll("dt")].find((term) => term.textContent === label)?.nextElementSibling?.textContent;
  try {
    await waitFor(() => expect(control(screen.container, "项目 1 表现")).not.toBeNull());
    await changeView(screen.container, "执行指标");
    const first = control(screen.container, "项目 1 表现")!;
    const second = control(screen.container, "项目 2 表现")!;
    expect(metric(first, "平均执行积分")).toBe("2.75 · 部分");
    expect(metric(second, "平均执行积分")).toBe("0");
    expect(metric(first, "累计实际积分")).toBe("140");
    expect(metric(second, "累计实际积分")).toBe("210");
    expect(first.textContent).toContain("有效采样 4 · 有效评估 3");
    expect(second.textContent).toContain("有效采样 12 · 有效评估 11");
    expect(first.textContent).toContain("评估 Agent · 严谨评估配置");
    expect(second.textContent).toContain("评估 Agent · 简洁评估配置");
    expect(metric(first, "平均执行耗时")).toBe("2.0 秒");
    await changeView(screen.container, "评估指标");
    expect(first.textContent).toContain("7.25");
  } finally { await screen.close(); }
});

it.each(["boolean", "enum"] as const)("reads every %s distribution entry directly, including zero counts and the supplied shares", async (kind) => {
  const full = comparisonView();
  const field: ComparisonField = {
    jsonPointer: "/rating", title: "任务符合程度", description: null, kinds: [kind],
    values: kind === "boolean" ? [true, false] : ["完整", "部分", "缺失"], nullable: false, dataCount: 24,
  };
  const score: OutputFieldSummary = {
    ...comparisonScore(0, 7), jsonPointer: "/rating", title: field.title, kinds: field.kinds, numeric: null,
    distribution: kind === "boolean" ? [
      { value: true, count: 1, evaluations: 1, share: 0.625 },
      { value: false, count: 0, evaluations: 0, share: 0 },
    ] : [
      { value: "完整", count: 1, evaluations: 1, share: 0.625 },
      { value: "部分", count: 3, evaluations: 3, share: 0.25 },
      { value: "缺失", count: 0, evaluations: 0, share: 0 },
    ],
  };
  reads.comparison.mockResolvedValue({ ...full, fields: [field], selectedField: field, summary: full.summary.map((value) => ({ ...value, score })) });
  const screen = await mount(comparePath({ jsonPointer: "/rating" }));
  try {
    await waitFor(() => expect(control(screen.container, "项目 1 表现")).not.toBeNull());
    const distribution = control(control(screen.container, "项目 1 表现")!, "评分分布")!;
    expect(distribution).not.toBeNull();
    const entries = [...distribution.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent?.trim()]);
    expect(entries).toEqual(kind === "boolean"
      ? [["是", "62.5% · 1 次"], ["否", "0% · 0 次"]]
      : [["完整", "62.5% · 1 次"], ["部分", "25.0% · 3 次"], ["缺失", "0% · 0 次"]]);
    expect(control(screen.container, "项目 1 表现")?.textContent).toContain("有效评分 N = 7");
  } finally { await screen.close(); }
});

it("keeps project selection copy focused on the product flow rather than comparison internals", async () => {
  const screen = await mount();
  try {
    await waitFor(() => expect(control(screen.container, "选择 项目 1")).not.toBeNull());
    expect(screen.container.textContent).not.toContain("基线");
    expect(screen.container.textContent).toContain("至少选择 2 个");
  } finally { await screen.close(); }
});

it.each(["evaluation", "execution"] as const)("keeps an explicit recovery path in %s when the chosen field loses common scores, without silently changing scope", async (viewMode) => {
  const available = comparisonView(true);
  reads.comparison.mockImplementation(async (query: ProjectComparisonQuery): Promise<ProjectComparisonView> => query.jsonPointer === "/passed" ? available : {
    ...available, fields: available.fields.filter((field) => field.jsonPointer === "/passed"), selectedField: null,
    datasetId: query.datasetId ?? null, datasets: [], summary: [], rows: [],
  });
  const screen = await mount(comparePath({
    jsonPointer: "/score", datasetId: "dataset-b", dataId: "data-0", sampling: '{"p1":"p1-data-0-valid-b"}',
    ...viewMode === "execution" ? { viewMode } : {},
  }));
  try {
    await waitFor(() => expect(screen.container.textContent).toContain("当前指标暂无共同评分"));
    const reading = { dashboardId: savedDashboardId, jsonPointer: "/score", datasetId: "dataset-b", dataId: "data-0", sampling: { p1: "p1-data-0-valid-b" } };
    expect(screen.router.state.location.search).toMatchObject(reading);
    expect(reads.comparison).toHaveBeenCalledTimes(1);
    if (viewMode === "execution") {
      expect(control(screen.container, "共同指标")).toBeNull();
      await click(button(screen.container, "切换到评估指标"));
      await waitFor(() => expect(control(screen.container, "共同指标")).not.toBeNull());
      expect(screen.router.state.location.search).toMatchObject(reading);
      expect(screen.router.state.location.search.viewMode).toBeUndefined();
      expect(reads.comparison).toHaveBeenCalledTimes(1);
    }
    const metric = control(screen.container, "共同指标") as HTMLSelectElement;
    expect(metric).not.toBeNull();
    expect(metric.selectedOptions[0]?.textContent).toContain("当前指标暂无共同评分");
    expect([...metric.options].some((option) => option.value === "/passed")).toBe(true);
    expect(screen.container.textContent).not.toContain("所选项目还没有在同一共同指标上");
    expect(screen.router.state.location.search).toMatchObject({ dashboardId: savedDashboardId, jsonPointer: "/score", datasetId: "dataset-b" });
    expect(reads.comparison).toHaveBeenCalledTimes(1);
    await select(metric, "/passed");
    await waitFor(() => expect(control(screen.container, "当前范围表现")?.textContent).toContain("否 100%"));
    expect(screen.router.state.location.search).toMatchObject({ dashboardId: savedDashboardId, jsonPointer: "/passed" });
    expect(screen.router.state.location.search.datasetId).toBeUndefined();
    expect(reads.projects).not.toHaveBeenCalled();
    expect(reads.createDashboard).not.toHaveBeenCalled();
    expect(reads.updateDashboard).not.toHaveBeenCalled();
  } finally { await screen.close(); }
});

it("sorts numeric data by the supplied spread, preserves ties and sidebar order, and resets paging and scope state", async () => {
  const full = comparisonView();
  const view: ProjectComparisonView = {
    ...full, rows: full.rows.map((row, index) => ({ ...row, spread: index >= 22 ? 12 : index === 0 ? null : index === 5 ? 0 : 3 })),
  };
  reads.comparison.mockImplementation(async (query: ProjectComparisonQuery) => query.jsonPointer === "/passed" ? comparisonView(true) : view);
  const screen = await mount(comparePath({ jsonPointer: "/score", dataPage: "2" }));
  const rowNames = () => [...screen.container.querySelectorAll('table[aria-label="逐条数据对比"] tbody tr')].map((row) => row.querySelector("td a")?.textContent);
  try {
    await waitFor(() => expect(control(screen.container, "数据排序")).not.toBeNull());
    expect(rowNames()).toHaveLength(4);
    await select(control(screen.container, "数据排序"), "difference");
    expect(screen.router.state.location.search.sort).toBe("difference");
    expect(screen.router.state.location.search.dataPage).toBeUndefined();
    expect(rowNames().slice(0, 4)).toEqual(["用例 23", "用例 24", "用例 2", "用例 3"]);
    expect(control(screen.container, "当前范围表现")?.textContent).toContain("7.25");
    expect(control(screen.container, "当前范围表现")?.textContent).toContain("24条共同已评数据");
    await click(button(control(screen.container, "共同数据分页")!, "下一页"));
    expect(rowNames()).toHaveLength(4);
    expect(rowNames().slice(-2)).toEqual(["用例 6", "零分用例"]);
    await click(button(control(screen.container, "共同数据分页")!, "上一页"));
    await click(control(screen.container, "打开 用例 23"));
    const navigationOrder = [...control(screen.container, "数据列表")!.querySelectorAll("a")].map((link) => link.getAttribute("aria-label"));
    expect(navigationOrder.slice(0, 4)).toEqual(["切换到 用例 23", "切换到 用例 24", "切换到 用例 2", "切换到 用例 3"]);
    expect(reads.comparison).toHaveBeenCalledTimes(1);
    await select(control(screen.container, "数据排序"), "data");
    expect(screen.router.state.location.search.sort).toBeUndefined();
    expect(control(screen.container, "数据列表")!.querySelector("a")?.textContent).toContain("零分用例");
    await select(control(screen.container, "数据排序"), "difference");
    await click(control(screen.container, "范围 边界场景"));
    await waitFor(() => expect(control(screen.container, "数据排序")).not.toBeNull());
    expect(screen.router.state.location.search.sort).toBeUndefined();
    expect(screen.router.state.location.search.dataId).toBeUndefined();
    expect(rowNames()[0]).toBe("零分用例");
    await select(control(screen.container, "数据排序"), "difference");
    await select(control(screen.container, "共同指标"), "/passed");
    await waitFor(() => expect(control(screen.container, "当前范围表现")?.textContent).toContain("否 100%"));
    expect(screen.router.state.location.search.sort).toBeUndefined();
    expect(screen.router.state.location.search.datasetId).toBeUndefined();
  } finally { await screen.close(); }
});

it("restores categorical difference-first sorting from the URL and keeps equal categories in data order", async () => {
  const full = comparisonView(true);
  const field: ComparisonField = { ...full.selectedField!, dataCount: 5 };
  reads.comparison.mockResolvedValue({
    ...full, fields: [field], selectedField: field,
    rows: Array.from({ length: 5 }, (_, index) => ({ ...comparisonRow(index, true), different: index === 1 || index === 2 || index === 4 })),
    summary: full.summary.map((value) => ({ ...value, dataCount: 5 })),
  });
  const screen = await mount(comparePath({ jsonPointer: "/passed", sort: "difference" }));
  const rowNames = () => [...screen.container.querySelectorAll('table[aria-label="逐条数据对比"] tbody tr')].map((row) => row.querySelector("td a")?.textContent);
  try {
    await waitFor(() => expect(control(screen.container, "数据排序")).not.toBeNull());
    expect((control(screen.container, "数据排序") as HTMLSelectElement).value).toBe("difference");
    expect(rowNames()).toEqual(["用例 2", "用例 3", "用例 5", "零分用例", "用例 4"]);
    await select(control(screen.container, "数据排序"), "data");
    expect(rowNames()).toEqual(["零分用例", "用例 2", "用例 3", "用例 4", "用例 5"]);
    expect(control(screen.container, "当前范围表现")?.textContent).toContain("5条共同已评数据");
  } finally { await screen.close(); }
});

it.each(["data", "project"] as const)("replaces an out-of-range %s page in the URL when data shrinks, and never revives it on growth", async (kind) => {
  const full = comparisonView();
  const projectList = Array.from({ length: 22 }, (_, index) => comparisonProject(index + 1));
  const screen = await mount(kind === "data" ? comparePath({ jsonPointer: "/score", dataPage: "2" }) : "/dashboard/new?projectPage=2");
  const pageField = kind === "data" ? "dataPage" : "projectPage";
  try {
    await waitFor(() => expect(screen.container.querySelectorAll("tbody tr")).toHaveLength(kind === "data" ? 4 : 2));
    expect(screen.router.state.location.search[pageField]).toBe(2);
    const historyLength = screen.router.history.length;
    const key = kind === "data" ? comparisonKeys.view({ projectIds: ["p1", "p2"], jsonPointer: "/score" }) : projectKeys.list();
    await act(async () => {
      if (kind === "data") screen.client.setQueryData(key, { ...full, rows: [full.rows[0]], summary: full.summary.map((value) => ({ ...value, dataCount: 1 })) });
      else screen.client.setQueryData(key, projectList.slice(0, 1));
    });
    await waitFor(() => expect(screen.router.state.location.search[pageField]).toBeUndefined());
    expect(screen.container.textContent).toContain("第 1 页");
    expect(screen.router.history.length).toBe(historyLength);
    await act(async () => { screen.client.setQueryData(key, kind === "data" ? full : projectList); });
    await waitFor(() => expect(screen.container.querySelectorAll("tbody tr")).toHaveLength(20));
    expect(screen.router.state.location.search[pageField]).toBeUndefined();
    expect(control(screen.container, kind === "data" ? "打开 零分用例" : "选择 项目 1")).not.toBeNull();
    expect(screen.router.history.length).toBe(historyLength);
  } finally { await screen.close(); }
});

it.each([
  { scope: "saved Project selection", next: { dashboardId: secondaryDashboardId } },
  { scope: "Dataset", next: { dashboardId: savedDashboardId, datasetId: "dataset-b" } },
  { scope: "edit view", next: { dashboardId: savedDashboardId, edit: true } },
] satisfies { scope: string; next: DashboardReadSearch & { edit?: boolean } }[])("does not backfill an old default metric after the $scope changes before the effect navigates", async ({ next }) => {
  reads.comparison.mockImplementation(async (query: ProjectComparisonQuery): Promise<ProjectComparisonView> => {
    const source = query.datasetId || query.projectIds[0] === "p3" ? comparisonView(true) : comparisonView();
    return {
      ...source, datasetId: query.datasetId ?? null,
      projects: source.projects.map((meta, index) => ({ ...meta, project: comparisonProject(Number(query.projectIds[index].slice(1))) })),
      summary: source.summary.map((value, index) => ({ ...value, projectId: query.projectIds[index] })),
      rows: source.rows.map((row) => ({ ...row, projects: row.projects.map((value, index) => ({ ...value, projectId: query.projectIds[index] })) })),
    };
  });
  const screen = await mount(comparePath(), false, next);
  try {
    if (!next.edit) {
      await waitFor(() => {
        expect(screen.router.state.location.search.jsonPointer).toBe("/passed");
        expect(control(screen.container, "当前范围表现")?.textContent).toContain("否 100%");
      });
      const projectIds = records.get(next.dashboardId!)!.projectIds;
      expect(reads.comparison.mock.calls.some(([query]) => query.projectIds.join() === projectIds.join()
        && query.datasetId === next.datasetId && query.jsonPointer === "/score")).toBe(false);
    } else {
      await waitFor(() => expect(control(screen.container, "选择 项目 1")).not.toBeNull());
      expect(screen.router.state.location.search.jsonPointer).toBeUndefined();
    }
    expect(screen.router.state.location.search.dashboardId).toBe(next.dashboardId);
    expect(screen.router.state.location.search.datasetId).toBe(next.datasetId);
    expect(screen.router.state.location.pathname).toBe(next.edit ? "/dashboard/edit" : "/dashboard");
    expect(reads.comparison.mock.calls[0]?.[0].jsonPointer).toBeUndefined();
  } finally { await screen.close(); }
});

it("returns the external main scroller to the scope beginning for Dataset, deep Data and metric navigation", async () => {
  reads.comparison.mockImplementation(async (query: ProjectComparisonQuery): Promise<ProjectComparisonView> => ({
    ...comparisonView(query.jsonPointer === "/passed"), datasetId: query.datasetId ?? null,
  }));
  const screen = await mount(comparePath({ jsonPointer: "/score" }));
  const main = screen.container.querySelector("main")!;
  try {
    await waitFor(() => expect(control(screen.container, "打开 用例 20")).not.toBeNull());
    main.scrollTop = 340;
    await click(control(screen.container, "范围 核心任务"));
    await waitFor(() => expect(screen.container.textContent).toContain("数据集表现"));
    expect(main.scrollTop).toBe(0);
    main.scrollTop = 300;
    await click(control(screen.container, "打开 用例 20"));
    await waitFor(() => expect(screen.container.textContent).toContain("单条数据表现"));
    expect(screen.router.state.location.search.dataId).toBe("data-19");
    expect(main.scrollTop).toBe(0);
    main.scrollTop = 280;
    await select(control(screen.container, "共同指标"), "/passed");
    await waitFor(() => expect(control(screen.container, "当前范围表现")?.textContent).toContain("否 100%"));
    expect(main.scrollTop).toBe(0);
  } finally { await screen.close(); }
});

it("preserves the external reading position for locating search, sorting, paging and independent Sampling changes", async () => {
  const screen = await mount(comparePath({ jsonPointer: "/score" }));
  const main = screen.container.querySelector("main")!;
  try {
    await waitFor(() => expect(control(screen.container, "共同数据分页")).not.toBeNull());
    main.scrollTop = 310;
    await type(control(screen.container, "搜索共同数据"), "用例");
    expect(main.scrollTop).toBe(310);
    await select(control(screen.container, "数据排序"), "difference");
    expect(main.scrollTop).toBe(310);
    await click(button(control(screen.container, "共同数据分页")!, "下一页"));
    expect(screen.router.state.location.search.dataPage).toBe(2);
    expect(main.scrollTop).toBe(310);
    await click(control(screen.container, "打开 用例 22"));
    await waitFor(() => expect(screen.container.textContent).toContain("p1-data-21-valid-a 的评估理由"));
    main.scrollTop = 260;
    await select(control(screen.container, "项目 1 的有效采样"), "p1-data-21-valid-b");
    await waitFor(() => expect(screen.container.textContent).toContain("p1-data-21-valid-b 的评估理由"));
    expect(main.scrollTop).toBe(260);
    await type(control(screen.container, "搜索共同数据"), "任务 22");
    await waitFor(() => expect(screen.router.state.location.search.dataPage).toBeUndefined());
    expect(screen.router.state.location.search.dataId).toBe("data-21");
    expect(main.scrollTop).toBe(260);
    await select(control(screen.container, "数据排序"), "data");
    expect(main.scrollTop).toBe(260);
  } finally { await screen.close(); }
});

it("keeps picker edits in one scroll scope but resets when starting a comparison or adjusting Projects", async () => {
  const screen = await mount();
  const main = screen.container.querySelector("main")!;
  try {
    await waitFor(() => expect(control(screen.container, "选择 项目 1")).not.toBeNull());
    await type(control(screen.container, "看板名称"), "滚动观察");
    main.scrollTop = 430;
    await click(control(screen.container, "选择 项目 1"));
    await click(control(screen.container, "选择 项目 2"));
    expect(main.scrollTop).toBe(430);
    await type(control(screen.container, "搜索对比项目"), "项目");
    expect(main.scrollTop).toBe(430);
    await click(button(screen.container, "下一页"));
    expect(screen.router.state.location.search.projectPage).toBe(2);
    expect(main.scrollTop).toBe(430);
    await click(button(screen.container, "创建看板"));
    await waitFor(() => {
      expect(screen.router.state.location.search.jsonPointer).toBe("/score");
      expect(screen.container.textContent).toContain("整体差异");
    });
    expect(main.scrollTop).toBe(0);
    main.scrollTop = 300;
    await click(link(screen.container, "编辑看板"));
    await waitFor(() => expect(control(screen.container, "选择 项目 21")).not.toBeNull());
    expect(main.scrollTop).toBe(0);
    main.scrollTop = 260;
    await click(control(screen.container, "选择 项目 21"));
    expect(main.scrollTop).toBe(260);
  } finally { await screen.close(); }
});
