import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { ProjectOverview, ProjectView, OutputFieldSummary } from "@/api-sdk/types";
import { click, render, select, type } from "@/test/render";
import { metricSummary, resourceStatistics } from "@/test/metrics";
import { MetricCell, ProjectResults, needsAttention, ResultCost } from "./project-results";
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/features/results/sampling-detail-page", () => ({ SamplingResult: ({ samplingId }: { samplingId: string }) => <div>result:{samplingId}</div> }));
const load = vi.hoisted(() => vi.fn());
vi.mock("@/api-sdk/metrics-api", async (original) => ({ ...await original<object>(), getSampleOverview: load }));
const summary = metricSummary(resourceStatistics(), resourceStatistics());
function fixtures() {
  const rows = [
    { projectSampleId: "single", dataId: "d1", datasetIds: ["a", "b"], samplingCount: 1, samplingIds: ["s1"], summary },
    { projectSampleId: "multiple", dataId: "d2", datasetIds: ["a"], samplingCount: 2, samplingIds: ["s2", "s3"], summary },
    { projectSampleId: "never", dataId: "d3", datasetIds: ["b"], samplingCount: 1, samplingIds: [], summary },
  ];
  return { overview: { summary, projectSamples: rows, datasets: [], runIds: [], project: { projectId: "p", ownerUserId: "owner", name: "Project", sourceBranch: "eval", createdAt: "2026-10-16T00:00:00Z" } } as ProjectOverview, view: {
    currentRun: null, datasets: [{ datasetId: "a", name: "A" }, { datasetId: "b", name: "B" }],
    projectSamples: rows.map((row) => ({ ...row, data: { name: row.projectSampleId, userPrompt: "Task" } })),
  } as unknown as ProjectView };
}
it("opens a single sampling directly, expands repeated samplings in place, and preserves list filters", async () => {
  load.mockResolvedValue({ samplings: ["s2", "s3"].map((samplingId) => ({ samplingId, execution: { status: "succeeded" }, summary })) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { view, overview } = fixtures();
  const screen = await render(<QueryClientProvider client={client}><ProjectResults projectId="p" view={view} overview={overview} /></QueryClientProvider>);
  const button = (text: string) => [...document.querySelectorAll('button')].find((el) => el.textContent === text);
  try {
    expect([...screen.container.querySelectorAll('button')].filter((el) => el.textContent === 'single')).toHaveLength(1);
    await click(button('single'));
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('result:s1'));
    expect(load).not.toHaveBeenCalled();
    await click(button('返回用例列表'));
    await click(button('展开 2 次采样'));
    await vi.waitFor(() => expect(document.body.textContent).toContain('采样 2'));
    expect(load).toHaveBeenCalledTimes(1);
    await select(document.querySelector('[aria-label="数据集筛选"]'), 'b');
    expect(button('multiple')).toBeUndefined();
    expect((button('never') as HTMLButtonElement).disabled).toBe(true);
    await click(button('single')); await click(button('返回用例列表'));
    expect((document.querySelector('[aria-label="数据集筛选"]') as HTMLSelectElement).value).toBe('b');
  } finally { await screen.unmount(); client.clear(); }
});
it("flags execution and validation failures without inventing a quality threshold", () => {
  const row = fixtures().overview.projectSamples[0]!;
  expect(needsAttention(row)).toBe(false);
  expect(needsAttention({ ...row, summary: { ...summary, evaluationOutputs: { ...summary.evaluationOutputs, validation: { valid: 0, invalid: 1, unavailable: 0 } } } })).toBe(true);
});

it("pages cases in groups of 20, retaining the overall result and expanded cases", async () => {
  const { view, overview } = fixtures();
  const rows = Array.from({ length: 45 }, (_, index) => ({
    ...overview.projectSamples[0]!, projectSampleId: `case-${String(index).padStart(2, "0")}`,
    samplingIds: index === 0 ? ["s2", "s3"] : [`s-${index}`],
  }));
  const data = { ...overview, projectSamples: rows };
  const project = { ...view, projectSamples: rows.map((row) => ({ ...view.projectSamples[0]!, ...row, data: { ...view.projectSamples[0]!.data, dataId: row.dataId, name: row.projectSampleId, userPrompt: "Task" } })) };
  load.mockResolvedValue({ samplings: ["s2", "s3"].map((samplingId) => ({ samplingId, execution: { status: "succeeded" }, summary })) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(<QueryClientProvider client={client}><ProjectResults projectId="p" view={project} overview={data} /></QueryClientProvider>);
  const page = (label: string) => [...screen.container.querySelectorAll('nav[aria-label="用例结果分页"] button')].find((button) => button.textContent === label);
  try {
    expect(screen.container.querySelectorAll("tbody tr")).toHaveLength(21);
    await click([...screen.container.querySelectorAll("button")].find((button) => button.textContent === "case-00"));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("采样 2"));
    await click(page("下一页"));
    expect(screen.container.querySelector("tbody tr")?.textContent).toContain("整体结果");
    expect(screen.container.textContent).toContain("case-20");
    expect(screen.container.textContent).not.toContain("case-00");
    await click(page("上一页"));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("采样 2"));
    await click(page("下一页"));
    await type(screen.container.querySelector('[aria-label="搜索用例"]'), "case-44");
    expect(screen.container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(screen.container.textContent).toContain("case-44");
    expect(page("上一页")).toHaveProperty("disabled", true);
  } finally { await screen.unmount(); client.clear(); }
});

it("pages expanded samplings independently and keeps their original sequence", async () => {
  const { view, overview } = fixtures();
  const outputs = { ...summary.evaluationOutputs, fields: ["完整性", "正确性"].map((title): OutputFieldSummary => ({ jsonPointer: "/" + title, title, description: "", kinds: ["number"], observationCount: 0, contributingEvaluationCount: 0, missingEvaluationCount: 1, coverage: "unavailable", diagnostics: [], numeric: null, distribution: [] })) };
  const sampled = { ...summary, evaluationOutputs: outputs };
  const data = { ...overview, summary: sampled, projectSamples: overview.projectSamples.map((row) => ({ ...row, summary: sampled })) };
  load.mockResolvedValue({ samplings: Array.from({ length: 25 }, (_, index) => ({
    samplingId: `sampling-${index}`, execution: { status: "succeeded" }, summary: sampled,
  })) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(<QueryClientProvider client={client}><ProjectResults projectId="p" view={view} overview={data} /></QueryClientProvider>);
  try {
    await click([...screen.container.querySelectorAll("button")].find((button) => button.textContent === "展开 2 次采样"));
    await vi.waitFor(() => expect(screen.container.querySelector('[aria-label="用例 multiple 采样分页"]')).not.toBeNull());
    const samplings = () => [...screen.container.querySelectorAll("tbody button")].filter((button) => /^采样 \d+$/u.test(button.textContent ?? ""));
    expect(samplings()).toHaveLength(20);
    const navigation = screen.container.querySelector('[aria-label="用例 multiple 采样分页"]')!;
    await click([...navigation.querySelectorAll("button")].find((button) => button.textContent === "下一页"));
    expect(samplings()).toHaveLength(5);
    expect(samplings()[0]?.textContent).toBe("采样 21");
    expect(samplings().at(-1)?.textContent).toBe("采样 25");
    expect(navigation.closest("td")?.colSpan).toBe(7);
    await select(screen.container.querySelector('[aria-label="评估指标"]'), "/正确性");
    expect(samplings()[0]?.textContent).toBe("采样 21");
    expect(navigation.closest("td")?.colSpan).toBe(6);
    expect(navigation.closest("td")?.colSpan).toBe(screen.container.querySelectorAll("thead th").length);
  } finally { await screen.unmount(); client.clear(); }
});


it("aligns schema metrics in shared table columns and filters columns without inventing a total", async () => {
  const field = (title: string, value: number): OutputFieldSummary => ({ jsonPointer: "/" + title, title, description: "", kinds: ["number"], observationCount: 2, contributingEvaluationCount: 2, missingEvaluationCount: 0, coverage: "complete", diagnostics: [], distribution: [], numeric: { count: 2, missing: 0, total: value * 2, mean: value, min: value - 1, max: value + 1, variance: 1, median: value } });
  const outputs = { ...summary.evaluationOutputs, fields: [field("完整性", 8), field("正确性", 6), field("表达清晰度", 9)] };
  const { view, overview } = fixtures();
  const data = { ...overview, summary: { ...summary, evaluationOutputs: outputs }, projectSamples: overview.projectSamples.map((row) => ({ ...row, summary: { ...summary, evaluationOutputs: outputs } })) };
  load.mockResolvedValue({ samplings: ["s2", "s3"].map((samplingId) => ({ samplingId, execution: { status: "succeeded" }, summary: { ...summary, evaluationOutputs: outputs } })) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(<QueryClientProvider client={client}><ProjectResults projectId="p" view={view} overview={data} /></QueryClientProvider>);
  try {
    const headers = () => [...screen.container.querySelectorAll('thead th')].map((el) => el.textContent);
    expect(headers()).toEqual(["用例 / 采样", "有效评估 / 执行完成", "完整性", "正确性", "表达清晰度", "积分 / 累计耗时", "缓存命中率 / 工具调用成功率", "操作"]);
    expect(screen.container.querySelectorAll("colgroup col")).toHaveLength(8);
    expect(screen.container.querySelector("table")?.style.minWidth).toBe("1245px");
    expect(screen.container.textContent).not.toContain("总分");
    expect(screen.container.textContent).toContain("7–9 · n=2");
    await click([...screen.container.querySelectorAll('button')].find((button) => button.textContent === '展开 2 次采样'));
    await vi.waitFor(() => expect(screen.container.textContent).toContain('采样 2'));
    expect([...screen.container.querySelectorAll('tbody tr')].map((row) => row.querySelectorAll('td').length)).toEqual([8, 8, 8, 8, 8, 8]);
    await select(screen.container.querySelector('[aria-label="评估指标"]'), '/正确性');
    expect(headers()).toEqual(["用例 / 采样", "有效评估 / 执行完成", "正确性", "积分 / 累计耗时", "缓存命中率 / 工具调用成功率", "操作"]);
    expect(screen.container.querySelectorAll("colgroup col")).toHaveLength(6);
    expect(screen.container.querySelector("table")?.style.minWidth).toBe("1045px");
    expect([...screen.container.querySelectorAll('tbody tr')].every((row) => row.querySelectorAll('td').length === 6)).toBe(true);
  } finally { await screen.unmount(); client.clear(); }
});

it("stacks valid evaluations above completed executions without sharing denominators or adding toggles", async () => {
  const { view, overview } = fixtures();
  const counted = (valid: number, evaluations: number, succeeded: number, records: number) => ({
    ...summary, counts: { ...summary.counts, evaluations },
    execution: { ...summary.execution, records, statuses: { ...summary.execution.statuses, succeeded } },
    evaluationOutputs: { ...summary.evaluationOutputs, validation: { valid, invalid: 0, unavailable: evaluations - valid } },
  });
  const data = { ...overview, summary: counted(5, 11, 4, 7), projectSamples: overview.projectSamples.map((row) => ({ ...row, summary: counted(1, 6, 2, 3) })) };
  const screen = await render(<ProjectResults projectId="p" view={view} overview={data} />);
  try {
    const cells = [...screen.container.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("td")[1]!);
    expect([...cells[0]!.children].map((line) => line.textContent)).toEqual(["5/11", "4/7"]);
    for (const cell of cells.slice(1)) expect([...cell.children].map((line) => line.textContent)).toEqual(["1/6", "2/3"]);
    for (const cell of cells) {
      expect(cell.children[0]!.classList.contains("text-text-strong")).toBe(true);
      expect(cell.children[1]!.classList.contains("block")).toBe(true);
      expect(cell.children[1]!.classList.contains("text-[11px]")).toBe(true);
      expect(cell.children[1]!.classList.contains("text-text-muted")).toBe(true);
      expect(cell.querySelector("button, details")).toBeNull();
    }
  } finally { await screen.unmount(); }
});

it("keeps case exception hints grouped with their evaluation or execution stage", async () => {
  const { view, overview } = fixtures();
  const exceptional = {
    ...summary, counts: { ...summary.counts, evaluations: 9 },
    execution: { ...summary.execution, records: 4, statuses: { ...summary.execution.statuses, succeeded: 1, failed: 2, cancelled: 1 } },
    evaluation: { ...summary.evaluation, records: 9, statuses: { ...summary.evaluation.statuses, succeeded: 4, failed: 3, cancelled: 2 } },
    evaluationOutputs: { ...summary.evaluationOutputs, validation: { valid: 3, invalid: 1, unavailable: 5 } },
  };
  const data = { ...overview, projectSamples: overview.projectSamples.map((row) => ({ ...row, summary: row.projectSampleId === "multiple" ? exceptional : summary })) };
  const screen = await render(<ProjectResults projectId="p" view={view} overview={data} />);
  try {
    await select(screen.container.querySelector('[aria-label="结果筛选"]'), "attention");
    const rows = [...screen.container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    const cell = rows[1]!.querySelectorAll("td")[1]!;
    expect([...cell.children].map((line) => line.textContent)).toEqual([
      "3/9评估失败 3评估取消 2格式无效 1",
      "1/4执行失败 2执行取消 1",
    ]);
    expect(cell.children[0]!.querySelector(".text-danger")?.textContent).toBe("评估失败 3");
    expect(cell.children[1]!.querySelector(".text-danger")?.textContent).toBe("执行失败 2");
    expect(cell.children[0]!.querySelector(".text-warning")?.textContent).toBe("格式无效 1");
  } finally { await screen.unmount(); }
});

it("retains every sampling execution status below evaluation counts and exception hints", async () => {
  const { view, overview } = fixtures();
  const statuses = [["queued", "排队中"], ["starting", "启动中"], ["running", "运行中"], ["retrying", "重试中"], ["succeeded", "成功"], ["failed", "失败"], ["cancelled", "已取消"]] as const;
  const sampled = {
    ...summary, counts: { ...summary.counts, evaluations: 4 },
    evaluation: { ...summary.evaluation, records: 4, statuses: { ...summary.evaluation.statuses, succeeded: 2, failed: 1, cancelled: 1 } },
    evaluationOutputs: { ...summary.evaluationOutputs, validation: { valid: 1, invalid: 1, unavailable: 2 } },
  };
  load.mockResolvedValue({ samplings: statuses.map(([status]) => ({ samplingId: status, execution: { status }, summary: sampled })) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(<QueryClientProvider client={client}><ProjectResults projectId="p" view={view} overview={overview} /></QueryClientProvider>);
  try {
    await click([...screen.container.querySelectorAll("button")].find((button) => button.textContent === "展开 2 次采样"));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("采样 7"));
    for (const [index, [, label]] of statuses.entries()) {
      const row = [...screen.container.querySelectorAll("tbody tr")].find((item) => item.querySelector("td button")?.textContent === `采样 ${index + 1}`)!;
      const cell = row.querySelectorAll("td")[1]!;
      expect([...cell.children].map((line) => line.textContent)).toEqual(["1/4评估失败评估取消格式无效 1", label]);
      expect(cell.children[0]!.classList.contains("text-text-strong")).toBe(true);
      expect(cell.children[1]!.classList.contains("block")).toBe(true);
      expect(cell.children[1]!.classList.contains("text-[11px]")).toBe(true);
      expect(cell.children[1]!.classList.contains("text-text-muted")).toBe(true);
    }
  } finally { await screen.unmount(); client.clear(); }
});

it.each(["loading", "error"])("spans the merged columns for %s sampling feedback before and after metric filtering", async (state) => {
  const { view, overview } = fixtures();
  const fields = ["完整性", "正确性"].map((title): OutputFieldSummary => ({ jsonPointer: "/" + title, title, description: "", kinds: ["number"], observationCount: 0, contributingEvaluationCount: 0, missingEvaluationCount: 1, coverage: "unavailable", diagnostics: [], numeric: null, distribution: [] }));
  const data = { ...overview, summary: { ...summary, evaluationOutputs: { ...summary.evaluationOutputs, fields } } };
  load.mockImplementation(() => state === "loading" ? new Promise<never>(() => {}) : Promise.reject(new Error("采样读取失败")));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(<QueryClientProvider client={client}><ProjectResults projectId="p" view={view} overview={data} /></QueryClientProvider>);
  const feedback = () => [...screen.container.querySelectorAll<HTMLTableCellElement>("tbody td")].find((cell) => state === "loading" ? cell.querySelector('[aria-label="加载中"]') : cell.textContent?.includes("采样读取失败"));
  try {
    await click([...screen.container.querySelectorAll("button")].find((button) => button.textContent === "展开 2 次采样"));
    await vi.waitFor(() => expect(feedback()).toBeDefined());
    expect(feedback()?.colSpan).toBe(7);
    await select(screen.container.querySelector('[aria-label="评估指标"]'), "/正确性");
    expect(feedback()?.colSpan).toBe(6);
    expect(feedback()?.colSpan).toBe(screen.container.querySelectorAll("thead th").length);
  } finally { await screen.unmount(); client.clear(); }
});

it("filters partial missing results from the summary without retaining unrelated dataset filters", async () => {
  const { view, overview } = fixtures();
  const missing = { ...summary, evaluationOutputs: { ...summary.evaluationOutputs, validation: { valid: 1, invalid: 0, unavailable: 1 } } };
  const data = { ...overview, summary: missing, projectSamples: overview.projectSamples.map((row) => ({ ...row, summary: row.projectSampleId === "multiple" ? missing : { ...summary, evaluationOutputs: { ...summary.evaluationOutputs, validation: { valid: 1, invalid: 0, unavailable: 0 } } } })) };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(<QueryClientProvider client={client}><ProjectResults projectId="p" view={view} overview={data} /></QueryClientProvider>);
  try {
    await select(screen.container.querySelector('[aria-label="数据集筛选"]'), 'b');
    await click([...screen.container.querySelectorAll('button')].find((button) => button.textContent === '结果未获得 1'));
    expect((screen.container.querySelector('[aria-label="数据集筛选"]') as HTMLSelectElement).value).toBe('');
    expect([...screen.container.querySelectorAll('tbody tr')].map((row) => row.querySelector('td')?.textContent)).toEqual(['整体结果项目全部当前采样', 'multipleA']);
  } finally { await screen.unmount(); client.clear(); }
});
it("shows execution cost and duration independently of evaluation, preserving zero, missing and partial data", async () => {
  const execution = { ...summary.execution, agentDurationMs: { ...summary.execution.agentDurationMs, total: 3_000, missing: 0 } };
  const known = {
    ...summary, execution,
    evaluation: { ...summary.evaluation, agentDurationMs: { ...summary.evaluation.agentDurationMs, total: 20_000 } },
    executionAgent: { ...summary.executionAgent, costs: { ...summary.executionAgent.costs, chargedUnits: { value: 0, coverage: "complete" as const } } },
    evaluationAgents: { ...summary.evaluationAgents, costs: { ...summary.evaluationAgents.costs, chargedUnits: { value: null, coverage: "unavailable" as const } } },
  };
  const zero = await render(<ResultCost summary={known} />);
  try { expect(zero.container.textContent).toBe("0 积分3.0 秒"); } finally { await zero.unmount(); }

  const partial = await render(<ResultCost summary={{
    ...known,
    execution: { ...execution, agentDurationMs: { ...execution.agentDurationMs, missing: 1 } },
    executionAgent: { ...known.executionAgent, costs: { ...known.executionAgent.costs, chargedUnits: { value: 2, coverage: "partial" } } },
  }} />);
  try { expect(partial.container.textContent).toBe("2 积分 · 部分3.0 秒 · 部分"); } finally { await partial.unmount(); }

  const incomplete = await render(<ResultCost summary={{
    ...known,
    execution: { ...execution, agentDurationMs: { ...execution.agentDurationMs, total: null } },
    executionAgent: { ...known.executionAgent, costs: { ...known.executionAgent.costs, chargedUnits: { value: null, coverage: "unavailable" } } },
  }} />);
  try { expect(incomplete.container.textContent).toBe("积分未获得耗时未获得"); } finally { await incomplete.unmount(); }
});

it("shows execution-only rates for overall, case and sampling rows without averaging child summaries", async () => {
  const base = resourceStatistics();
  const makeSummary = (units: number, duration: number, cache: number, tools: number) => {
    const result = metricSummary(
      resourceStatistics({
        costs: { ...base.costs, chargedUnits: { value: units, coverage: "complete" } },
        cacheHitRate: { value: cache, coverage: "complete" },
        trajectory: { ...base.trajectory, toolSuccessRate: { value: tools, coverage: "complete" } },
      }),
      resourceStatistics({
        costs: { ...base.costs, chargedUnits: { value: 900, coverage: "complete" } },
        cacheHitRate: { value: 0.99, coverage: "complete" },
        trajectory: { ...base.trajectory, toolSuccessRate: { value: 0.01, coverage: "complete" } },
      }),
    );
    return { ...result, execution: { ...result.execution, agentDurationMs: { ...result.execution.agentDurationMs, total: duration } },
      evaluation: { ...result.evaluation, agentDurationMs: { ...result.evaluation.agentDurationMs, total: 60_000 } } };
  };
  const overall = makeSummary(18, 5_000, 0.4, 0.75);
  const caseSummary = makeSummary(8, 2_000, 0.5, 0.5);
  const sampled = makeSummary(3, 1_000, 0, 1);
  const { view, overview } = fixtures();
  const data = { ...overview, summary: overall, projectSamples: overview.projectSamples.map((row) => ({ ...row, summary: row.projectSampleId === "multiple" ? caseSummary : sampled })) };
  load.mockResolvedValue({ samplings: ["s2", "s3"].map((samplingId) => ({ samplingId, execution: { status: "succeeded" }, summary: sampled })) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(<QueryClientProvider client={client}><ProjectResults projectId="p" view={view} overview={data} /></QueryClientProvider>);
  try {
    const cells = (row: Element) => [
      row.querySelectorAll("td")[2]!.textContent,
      [...row.querySelectorAll("td")[3]!.firstElementChild!.children].map((value) => value.textContent),
    ];
    let rows = [...screen.container.querySelectorAll("tbody tr")];
    expect(cells(rows[0]!)).toEqual(["18 积分5.0 秒", ["40.0%", "75.0%"]]);
    expect(cells(rows[2]!)).toEqual(["8 积分2.0 秒", ["50.0%", "50.0%"]]);
    const rates = rows[0]!.querySelectorAll("td")[3]!.firstElementChild!;
    expect(rates.children[0]!.classList.contains("text-text-strong")).toBe(true);
    expect(rates.children[1]!.classList.contains("block")).toBe(true);
    expect(rates.children[1]!.classList.contains("text-[11px]")).toBe(true);
    expect(rates.children[1]!.classList.contains("text-text-muted")).toBe(true);
    await click([...screen.container.querySelectorAll("button")].find((button) => button.textContent === "展开 2 次采样"));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("采样 2"));
    rows = [...screen.container.querySelectorAll("tbody tr")];
    expect(cells(rows[3]!)).toEqual(["3 积分1.0 秒", ["0%", "100%"]]);
  } finally { await screen.unmount(); client.clear(); }
});

it("distinguishes missing rates and no terminal calls from zero, and marks partial coverage", async () => {
  const base = resourceStatistics();
  const { view, overview } = fixtures();
  const execution = resourceStatistics({
    cacheHitRate: { value: 0, coverage: "complete" },
    trajectory: { ...base.trajectory, toolSuccessRate: { value: null, coverage: "complete" } },
  });
  const empty = metricSummary(execution, base);
  const missing = metricSummary(resourceStatistics({
    cacheHitRate: { value: null, coverage: "unavailable" },
    trajectory: { ...base.trajectory, toolSuccessRate: { value: null, coverage: "unavailable" } },
  }), base);
  const partial = metricSummary(resourceStatistics({
    cacheHitRate: { value: 0.5, coverage: "partial" },
    trajectory: { ...base.trajectory, toolSuccessRate: { value: 0, coverage: "partial" } },
  }), base);
  const data = { ...overview, summary: empty, projectSamples: overview.projectSamples.map((row, index) => ({ ...row, summary: index === 0 ? missing : partial })) };
  const screen = await render(<ProjectResults projectId="p" view={view} overview={data} />);
  try {
    const rows = [...screen.container.querySelectorAll("tbody tr")];
    const rates = (index: number) => [...rows[index]!.querySelectorAll("td")[3]!.firstElementChild!.children].map((value) => value.textContent);
    expect(rates(0)).toEqual(["0%", "—"]);
    expect(rates(1)).toEqual(["未获得", "未获得"]);
    expect(rates(2)).toEqual(["50.0% · 部分", "0% · 部分"]);
  } finally { await screen.unmount(); }
});

it("does not repeat field-level missing counts in result cells", async () => {
  const field: OutputFieldSummary = {
    jsonPointer: "/score", title: "分数", description: "", kinds: ["number"], observationCount: 2,
    contributingEvaluationCount: 2, missingEvaluationCount: 4, coverage: "partial", diagnostics: [], distribution: [],
    numeric: { count: 2, missing: 0, total: 16, mean: 8, min: 7, max: 9, variance: 1, median: 8 },
  };
  const screen = await render(<MetricCell field={field} />);
  try { expect(screen.container.textContent).not.toContain("缺4"); } finally { await screen.unmount(); }
});
