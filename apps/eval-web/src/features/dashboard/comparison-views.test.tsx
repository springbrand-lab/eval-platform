import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act, useState, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ComparisonDataProjectValues, ComparisonDataRow, ComparisonProjectValues, ProjectComparisonView, ProjectView, SamplingDetail } from "@/api-sdk/types";
import { useTablePagination } from "@/components/ui/pagination";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ComparisonViewSwitch, type ComparisonViewMode } from "@/features/metrics/comparison-view";
import { SamplingResult } from "@/features/results/sampling-detail-page";
import { comparisonProjectView, comparisonRow, comparisonSampling, comparisonScore, comparisonView } from "@/test/comparison";
import { click, render, select } from "@/test/render";
import { ComparisonDataResults, ComparisonDataTable, DataNavigation } from "./comparison-data";
import { ComparisonSummary } from "./comparison-summary";
import type { DashboardSearch } from "./dashboard-search";

const reads = vi.hoisted(() => ({
  project: vi.fn<(projectId: string, signal?: AbortSignal) => Promise<ProjectView>>(),
  sampling: vi.fn<(projectId: string, samplingId: string, signal?: AbortSignal) => Promise<SamplingDetail>>(),
  file: vi.fn<typeof import("@/api-sdk/observations-api").getWorkspaceFile>(),
}));
vi.mock("@/api-sdk/projects-api", async (original) => ({ ...await original<object>(), getProject: reads.project }));
vi.mock("@/api-sdk/metrics-api", async (original) => ({ ...await original<object>(), getSamplingDetail: reads.sampling }));
vi.mock("@/api-sdk/runs-api", async (original) => ({ ...await original<object>(), listSamplingEvaluations: async () => [] }));
vi.mock("@/api-sdk/observations-api", async (original) => ({ ...await original<object>(), getWorkspaceFile: reads.file }));
vi.mock("@/components/files/file-preview", () => ({
  FilePreview: ({ file, readFile }: { file: { path: string }; readFile: (path: string, signal: AbortSignal) => Promise<Blob> }) =>
    <button onClick={() => void readFile(file.path, new AbortController().signal)}>读取文件 {file.path}</button>,
}));
vi.mock("@/features/observation/messages-tab", () => ({ MessagesTab: () => <div>只读会话</div> }));
vi.mock("@/features/observation/trajectory-tab", () => ({ TrajectoryTab: () => <div>只读轨迹</div> }));

beforeEach(() => {
  vi.clearAllMocks();
  reads.project.mockImplementation(async (projectId) => comparisonProjectView(projectId));
  reads.sampling.mockImplementation(async (projectId, samplingId) => samplingDetail(projectId, samplingId));
  reads.file.mockResolvedValue(new Blob(["artifact"]));
  window.scrollTo = vi.fn();
});

const control = (container: ParentNode, label: string) => container.querySelector(`[aria-label="${label}"]`);
const button = (container: ParentNode, text: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === text);

function executionValues(container: ParentNode) {
  const metrics = control(container, "执行 Agent 指标");
  expect(metrics).not.toBeNull();
  return Object.fromEntries([...metrics!.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]));
}

async function changeView(container: ParentNode, label: string) {
  const tab = [...control(container, "对比展示视图")!.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent === label)!;
  await act(async () => {
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    tab.click();
  });
}

async function waitFor(check: () => void) {
  let error: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    try { check(); return; } catch (failure) { error = failure; }
  }
  throw error;
}

async function mount(node: ReactNode) {
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({ getParentRoute: () => root, path: "/dashboard", component: () => node });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/dashboard"] }),
    defaultPendingMinMs: 0,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(<TooltipProvider><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></TooltipProvider>);
  await act(async () => { await router.load(); });
  return { ...screen, close: async () => { await screen.unmount(); client.clear(); } };
}

function SummaryAndData({ comparison, initialViewMode }: { comparison: ProjectComparisonView; initialViewMode?: ComparisonViewMode }) {
  const [viewMode, setViewMode] = useState(initialViewMode);
  const [search, setSearch] = useState<DashboardSearch>({ projectId: ["p1", "p2"] });
  const pagination = useTablePagination(comparison.rows);
  const onChange = (patch: Partial<DashboardSearch>) => setSearch((previous) => ({ ...previous, ...patch }));
  return <>
    <ComparisonViewSwitch value={viewMode ?? "evaluation"} onChange={setViewMode} />
    <ComparisonSummary projects={comparison.projects} values={comparison.summary} title="整体表现" scope="全部共同数据" onRemove={() => {}} viewMode={viewMode} />
    <ComparisonDataTable view={comparison} search={search} onChange={onChange} pagination={pagination} viewMode={viewMode} />
    <DataNavigation search={search} onChange={onChange} pagination={pagination} viewMode={viewMode} />
  </>;
}

function resourceComparison(): ProjectComparisonView {
  const comparison = comparisonView();
  const row = comparisonRow(1);
  return {
    ...comparison,
    summary: comparison.summary.map((value): ComparisonProjectValues => value.projectId !== "p1" ? value : {
      ...value,
      resources: {
        chargedUnits: { value: 90, coverage: "partial" },
        chargedUnitsPerAgent: {
          ...value.resources.chargedUnitsPerAgent,
          count: 36, missing: 12, mean: 2.5, total: 90, min: 2.5, max: 2.5, median: 2.5, coverage: "partial",
        },
        agentDurationMs: {
          ...value.resources.agentDurationMs,
          count: 36, missing: 12, mean: 1_234, total: 44_424, min: 1_234, max: 1_234, median: 1_234,
        },
        cacheHitRate: { value: 0.25, coverage: "complete" },
        toolSuccessRate: { value: 0.9, coverage: "partial" },
      },
    }).toReversed(),
    rows: [{
      ...row,
      projects: row.projects.map((value): ComparisonDataProjectValues => {
        const available = value.projectId === "p1";
        return {
          ...value,
          resources: {
            chargedUnits: { value: available ? 0 : null, coverage: available ? "partial" : "unavailable" },
            chargedUnitsPerAgent: {
              ...value.resources.chargedUnitsPerAgent,
              count: available ? 1 : 0, missing: available ? 1 : 2,
              mean: available ? 0 : null, total: available ? 0 : null,
              min: available ? 0 : null, max: available ? 0 : null, median: available ? 0 : null,
              coverage: available ? "partial" : "unavailable",
            },
            agentDurationMs: {
              ...value.resources.agentDurationMs,
              count: available ? 1 : 0, missing: available ? 1 : 2,
              mean: available ? 0 : null, total: available ? 0 : null,
              min: available ? 0 : null, max: available ? 0 : null, median: available ? 0 : null,
            },
            cacheHitRate: available ? { value: 0, coverage: "complete" } : { value: null, coverage: "unavailable" },
            toolSuccessRate: available ? { value: 0, coverage: "partial" } : { value: null, coverage: "complete" },
          },
        };
      }).toReversed(),
    }],
  };
}

it("defaults to concise evaluation values and switches summary, Data and score-only navigation together", async () => {
  const screen = await mount(<SummaryAndData comparison={resourceComparison()} />);
  const summary = () => control(screen.container, "项目 1 表现")!;
  const table = () => control(screen.container, "逐条数据对比")!;
  const cells = () => table().querySelectorAll("tbody tr td");
  try {
    expect(summary().textContent).toContain("7.25");
    expect(summary().textContent).toContain("有效评分 N = 48");
    expect(summary().textContent).toContain("执行 Agent · 执行配置 1");
    expect(summary().textContent).toContain("评估 Agent · 统一评估配置");
    expect(summary().textContent).toContain("有效采样 48 · 有效评估 48");
    expect(cells()[1].textContent).toContain("3");
    expect(cells()[2].textContent).toContain("6");
    expect([...table().querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["共同数据", "项目 1", "项目 2", "评分差异"]);
    expect(cells()[3].textContent).toContain("幅度 3");
    expect(control(screen.container, "执行 Agent 指标")).toBeNull();
    expect(screen.container.textContent).not.toContain("累计实际积分");
    expect(control(screen.container, "数据排序")).not.toBeNull();
    expect(screen.container.textContent).toContain("仅评分不同");
    expect(control(screen.container, "数据列表")?.textContent).toContain("评分不同");

    await changeView(screen.container, "执行指标");
    expect(executionValues(summary())).toEqual({
      "平均执行积分": "2.5 · 部分", "平均执行耗时": "1.2 秒 · 部分", "缓存命中率": "25.0%", "工具调用成功率": "90.0% · 部分",
    });
    expect(summary().textContent).not.toContain("有效评分");
    expect(summary().textContent).toContain("有效采样 48 · 有效评估 48");
    const distribution = [...summary().querySelectorAll("details dt")].find((term) => term.textContent === "单 Agent 积分分布 · 部分")!;
    expect(distribution.nextElementSibling?.textContent).toContain("已获得 36 · 未获得 12");
    expect(summary().querySelector("details")?.open).toBe(false);
    expect(executionValues(cells()[1])).toEqual({
      "平均执行积分": "0 · 部分", "平均执行耗时": "0 毫秒 · 部分", "缓存命中率": "0%", "工具调用成功率": "0% · 部分",
    });
    expect(executionValues(cells()[2])).toEqual({
      "平均执行积分": "未获得", "平均执行耗时": "未获得", "缓存命中率": "未获得", "工具调用成功率": "—",
    });
    expect(cells()[1].textContent).toContain("有效采样 2 · 有效评估 2");
    expect([...table().querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["共同数据", "项目 1", "项目 2"]);
    expect(control(screen.container, "数据排序")).toBeNull();
    expect(control(screen.container, "搜索共同数据")).not.toBeNull();
    expect(screen.container.textContent).not.toMatch(/仅评分不同|评分差异|差异优先|幅度 3|评分相同|评分不同/u);
    expect(screen.container.querySelectorAll('dl[aria-label="执行 Agent 指标"]')).toHaveLength(4);
    expect(control(screen.container, "当前范围表现")?.textContent).toContain("24条共同已评数据");

    await changeView(screen.container, "评估指标");
    expect(summary().textContent).toContain("7.25");
    expect(summary().textContent).toContain("有效评分 N = 48");
    expect(control(screen.container, "执行 Agent 指标")).toBeNull();
    expect(control(screen.container, "数据排序")).not.toBeNull();
    expect(cells()).toHaveLength(4);
  } finally { await screen.close(); }
});

it.each([0, false] as const)("keeps the real %s evaluation and its effective N without an execution grid", async (value) => {
  const comparison = comparisonView(typeof value === "boolean");
  const screen = await mount(<SummaryAndData comparison={{
    ...comparison,
    summary: comparison.summary.map((item) => ({ ...item, score: comparisonScore(value, 2) })),
    rows: [comparisonRow(0, typeof value === "boolean")],
  }} />);
  try {
    const summary = control(screen.container, "项目 1 表现")!;
    const firstCell = control(screen.container, "逐条数据对比")!.querySelectorAll("tbody td")[1];
    expect(summary.textContent).toContain("有效评分 N = 2");
    expect(firstCell.textContent).toContain("有效评分 N = 2");
    if (value === false) {
      const negative = [...control(summary, "评分分布")!.querySelectorAll("dt")].find((term) => term.textContent === "否")!;
      expect(negative.nextElementSibling?.textContent).toContain("100%");
      const cellNegative = [...control(firstCell, "评分分布")!.querySelectorAll("dt")].find((term) => term.textContent === "否")!;
      expect(cellNegative.nextElementSibling?.textContent).toContain("100%");
    } else {
      expect(summary.textContent).toContain("0均值");
      expect(firstCell.textContent).toMatch(/^0有效评分/u);
    }
    expect(screen.container.textContent).not.toContain("无有效评分");
    expect(control(screen.container, "执行 Agent 指标")).toBeNull();
  } finally { await screen.close(); }
});

it("does not synthesize zero resources when the current Data has no Project value", async () => {
  const comparison = comparisonView();
  const row = comparisonRow(0);
  const screen = await mount(<SummaryAndData initialViewMode="execution" comparison={{
    ...comparison, rows: [{ ...row, projects: row.projects.filter((value) => value.projectId === "p1") }],
  }} />);
  try {
    const cells = control(screen.container, "逐条数据对比")!.querySelectorAll("tbody td");
    expect(cells[2].textContent).toBe("未获得");
    expect(control(cells[2], "执行 Agent 指标")).toBeNull();
  } finally { await screen.close(); }
});

function samplingDetail(projectId: string, samplingId: string): SamplingDetail {
  const detail = comparisonSampling(projectId, samplingId);
  const row = comparisonRow(samplingId.includes("data-1") ? 1 : 0);
  const nextData = row.dataId === "data-1";
  const second = samplingId.endsWith("-valid-b");
  return {
    ...detail,
    projectSample: { ...detail.projectSample, projectSampleId: `${projectId}-${row.dataId}`, dataId: row.dataId, data: row.data },
    sampling: { ...detail.sampling, projectSampleId: `${projectId}-${row.dataId}` },
    subject: {
      ...detail.subject,
      agentDurationMs: nextData ? 4_000 : projectId === "p2" ? 8_000 : second ? 0 : 3_500,
      artifacts: [{ artifactId: `${samplingId}-artifact`, path: `/${samplingId}.html`, kind: "file" }],
      resources: {
        ...detail.subject.resources,
        costs: { ...detail.subject.resources.costs, chargedUnits: { value: nextData ? projectId === "p1" ? 41 : 43 : projectId === "p2" ? 29 : second ? 0 : 17, coverage: "complete" } },
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
      output: { ...evaluation.output, rawJson: { score: 0, passed: false, reason: `${samplingId} 的评估理由`, evidence: [`/evidence/artifacts/${samplingId}.html`] } },
    })),
  };
}

function SamplingViews({ comparison }: { comparison: ProjectComparisonView }) {
  const [viewMode, setViewMode] = useState<ComparisonViewMode>();
  const [search, setSearch] = useState<DashboardSearch>({
    projectId: ["p1", "p2"], dataId: "data-0",
    sampling: { p1: "p1-data-1-valid-b", p2: "p2-data-0-valid-b" },
  });
  const row: ComparisonDataRow = comparison.rows.find((item) => item.dataId === search.dataId)!;
  return <>
    <ComparisonViewSwitch value={viewMode ?? "evaluation"} onChange={setViewMode} />
    <button onClick={() => setSearch((previous) => ({ ...previous, dataId: "data-1" }))}>阅读下一条 Data</button>
    <ComparisonDataResults view={comparison} row={row} search={search} onChange={(patch) => setSearch((previous) => ({ ...previous, ...patch }))} viewMode={viewMode} />
  </>;
}

it("uses each selected Sampling's actual subject values, independent selections and role-scoped evidence in both views", async () => {
  const comparison = comparisonView();
  const screen = await mount(<SamplingViews comparison={{ ...comparison, rows: [comparisonRow(0), comparisonRow(1)] }} />);
  const side = (project: number) => control(screen.container, `项目 ${project} 结果`)!;
  const metrics = (project: number) => control(side(project), "当前采样执行 Agent 指标")!;
  try {
    await waitFor(() => {
      expect(side(1).textContent).toContain("p1-data-0-valid-a 的评估理由");
      expect(side(2).textContent).toContain("p2-data-0-valid-b 的评估理由");
    });
    expect(control(screen.container, "当前采样执行 Agent 指标")).toBeNull();
    expect(control(side(1), "评估数值")?.textContent).toContain("否");
    expect(control(side(1), "产物与证据预览")).not.toBeNull();
    expect(reads.sampling).not.toHaveBeenCalledWith("p1", "p1-data-1-valid-b", expect.anything());
    expect(screen.container.textContent).not.toMatch(/重新执行|重新评估|重新收集结果/u);

    await changeView(screen.container, "执行指标");
    expect(executionValues(metrics(1))).toEqual({
      "实际执行积分": "17", "实际执行耗时": "3.5 秒", "缓存命中率": "20.0% · 部分", "工具调用成功率": "50.0%",
    });
    expect(executionValues(metrics(2))).toEqual({
      "实际执行积分": "29", "实际执行耗时": "8.0 秒", "缓存命中率": "未获得", "工具调用成功率": "100%",
    });
    expect(metrics(1).textContent).not.toContain("平均");
    expect(metrics(2).textContent).not.toContain("999");
    expect(side(1).textContent).toContain("p1-data-0-valid-a 的评估理由");

    await select(control(screen.container, "项目 1 的有效采样"), "p1-data-0-valid-b");
    await waitFor(() => expect(side(1).textContent).toContain("p1-data-0-valid-b 的评估理由"));
    expect(executionValues(metrics(1))).toEqual({
      "实际执行积分": "0", "实际执行耗时": "0 毫秒", "缓存命中率": "0%", "工具调用成功率": "—",
    });
    expect(executionValues(metrics(2))["实际执行积分"]).toBe("29");
    expect(side(2).textContent).toContain("p2-data-0-valid-b 的评估理由");
    expect(screen.container.querySelector<HTMLSelectElement>('[aria-label="项目 2 的有效采样"]')?.value).toBe("p2-data-0-valid-b");
    await click(button(side(1), "读取文件 /p1-data-0-valid-b.html"));
    expect(reads.file).toHaveBeenLastCalledWith("p1", "samplings", "p1-data-0-valid-b", "/p1-data-0-valid-b.html", expect.any(AbortSignal));
    await click(button(side(2), "/evidence/artifacts/p2-data-0-valid-b.html"));
    await click(button(side(2), "读取文件 /evidence/artifacts/p2-data-0-valid-b.html"));
    expect(reads.file).toHaveBeenLastCalledWith("p2", "evaluations", "p2-data-0-valid-b-evaluation", "/evidence/artifacts/p2-data-0-valid-b.html", expect.any(AbortSignal));

    await changeView(screen.container, "评估指标");
    expect(control(screen.container, "当前采样执行 Agent 指标")).toBeNull();
    expect(side(1).textContent).toContain("p1-data-0-valid-b 的评估理由");
    expect(button(side(2), "读取文件 /evidence/artifacts/p2-data-0-valid-b.html")).toBeDefined();
    await changeView(screen.container, "执行指标");
    expect(executionValues(metrics(1))["实际执行积分"]).toBe("0");

    await click(button(screen.container, "阅读下一条 Data"));
    await waitFor(() => {
      expect(side(1).textContent).toContain("p1-data-1-valid-a 的评估理由");
      expect(side(2).textContent).toContain("p2-data-1-valid-a 的评估理由");
    });
    expect(executionValues(metrics(1))["实际执行积分"]).toBe("41");
    expect(executionValues(metrics(2))["实际执行积分"]).toBe("43");
    expect(side(1).textContent).not.toContain("p1-data-0-valid-b 的评估理由");
    expect(button(side(2), "读取文件 /p2-data-1-valid-a.html")).toBeDefined();
    expect(button(side(2), "读取文件 /evidence/artifacts/p2-data-0-valid-b.html")).toBeUndefined();
  } finally { await screen.close(); }
});

it("defaults a reused comparison SamplingResult to evaluation without adding an execution band", async () => {
  const screen = await mount(<SamplingResult projectId="p1" samplingId="p1-data-0-valid-a" presentation="comparison" />);
  try {
    await waitFor(() => expect(screen.container.textContent).toContain("p1-data-0-valid-a 的评估理由"));
    expect(control(screen.container, "当前采样执行 Agent 指标")).toBeNull();
    expect(control(screen.container, "评估数值")?.textContent).toContain("否");
    expect(control(screen.container, "产物与证据预览")).not.toBeNull();
  } finally { await screen.close(); }
});
