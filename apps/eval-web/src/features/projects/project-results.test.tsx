import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { ProjectOverview, ProjectView, OutputFieldSummary } from "@/api-sdk/types";
import { click, render, select } from "@/test/render";
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
    expect(headers()).toEqual(["用例 / 采样", "执行完成", "有效评估", "完整性", "正确性", "表达清晰度", "积分 / 累计耗时", "操作"]);
    expect(screen.container.textContent).not.toContain("总分");
    expect(screen.container.textContent).toContain("7–9 · n=2");
    await click([...screen.container.querySelectorAll('button')].find((button) => button.textContent === '展开 2 次采样'));
    await vi.waitFor(() => expect(screen.container.textContent).toContain('采样 2'));
    expect([...screen.container.querySelectorAll('tbody tr')].map((row) => row.querySelectorAll('td').length)).toEqual([8, 8, 8, 8, 8, 8]);
    await select(screen.container.querySelector('[aria-label="评估指标"]'), '/正确性');
    expect(headers()).toEqual(["用例 / 采样", "执行完成", "有效评估", "正确性", "积分 / 累计耗时", "操作"]);
    expect([...screen.container.querySelectorAll('tbody tr')].every((row) => row.querySelectorAll('td').length === 6)).toBe(true);
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
it("does not turn missing cost or duration into zero", async () => {
  const incomplete = { ...summary, evaluationAgents: { ...summary.evaluationAgents, costs: { ...summary.evaluationAgents.costs, chargedUnits: { value: null, coverage: 'unavailable' as const } } } };
  const screen = await render(<ResultCost summary={incomplete} />);
  try { expect(screen.container.textContent).toBe('积分未获得耗时未获得'); } finally { await screen.unmount(); }
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
