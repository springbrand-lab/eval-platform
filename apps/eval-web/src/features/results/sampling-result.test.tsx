import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { click, render } from "@/test/render";
import { agentMetric, metricSummary, resourceStatistics } from "@/test/metrics";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SamplingResult } from "./sampling-detail-page";
const api = vi.hoisted(() => ({ detail: vi.fn(), messages: vi.fn(async () => []), file: vi.fn(async () => new Blob(['html'])),
  tree: vi.fn(async (_project: string, kind: string) => kind === 'samplings'
    ? [{ name: 'notes.json', path: '/notes.json', type: 'file', updatedAt: 3 }, { name: 'index.html', path: '/index.html', type: 'file', updatedAt: 2 }]
    : [{ name: 'evidence', path: '/evidence', type: 'directory', children: [{ name: 'index.html', path: '/evidence/artifacts/index.html', type: 'file', updatedAt: 1 }, { name: 'report.md', path: '/evidence/report.md', type: 'file', updatedAt: 5 }] }]) }));
vi.mock("@/features/projects/use-project", () => ({ useProject: () => ({ data: { currentRun: null } }) }));
vi.mock("@/api-sdk/metrics-api", async (original) => ({ ...await original<object>(), getSamplingDetail: api.detail }));
vi.mock("@/api-sdk/runs-api", async (original) => ({ ...await original<object>(), listSamplingEvaluations: async () => [] }));
vi.mock("@/api-sdk/observations-api", async (original) => ({ ...await original<object>(), getWorkspaceFile: api.file, getMessages: api.messages, getWorkspaceTree: api.tree }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/components/files/file-preview", () => ({ FilePreview: ({ file, readFile }: { file: { path: string }; readFile: (path: string, signal: AbortSignal) => Promise<Blob> }) => <button onClick={() => void readFile(file.path, new AbortController().signal)}>preview:{file.path}</button> }));
vi.mock("./agent-panel", () => ({ AgentPanel: () => <div>technical agent panel</div>, LangfuseLink: () => null }));
vi.mock("@/features/observation/messages-tab", () => ({ MessagesTab: () => <div>agent conversation</div> }));
vi.mock("@/features/observation/trajectory-tab", () => ({ TrajectoryTab: ({ kind, id }: { kind: string; id: string }) => <div>trace:{kind}:{id}</div> }));
it("leads with readable evaluation, reviews each Agent's conversation beside its Workspace, and opens evidence in the evaluator's Workspace", async () => {
  const resources = resourceStatistics();
  api.detail.mockResolvedValue({ projectSample: { data: { name: 'Case', userPrompt: 'Execute', evalPrompt: 'Evaluate' } }, sampling: { samplingId: 'sampling', execution: { status: 'succeeded' } }, subject: { ...agentMetric(resources), chatId: 'chat', artifacts: [{ artifactId: 'artifact', path: '/index.html', kind: 'file' }] },
    summary: { ...metricSummary(resources, resources), evaluationOutputs: { ...metricSummary(resources, resources).evaluationOutputs, fields: [{ jsonPointer: '/correctness', title: '正确性' }] } }, evaluations: [{ record: { evaluationId: 'evaluation', samplingId: 'sampling', status: { status: 'succeeded' }, attempts: [] }, agent: { ...agentMetric(resources), chatId: 'evaluation-chat' }, output: { rawJson: { score: 8, correctness: 9, passed: true, reason: 'Readable reason', evidence: ['/evidence/artifacts/index.html'] }, validation: { status: 'valid', errors: [] } } }] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(<TooltipProvider><QueryClientProvider client={client}><SamplingResult projectId="project" samplingId="sampling" /></QueryClientProvider></TooltipProvider>);
  const button = (text: string) => [...screen.container.querySelectorAll('button')].find((item) => item.textContent === text);
  try {
    await vi.waitFor(() => expect(screen.container.textContent).toContain('Readable reason'));
    expect(screen.container.textContent).not.toContain('technical agent panel');
    expect(screen.container.querySelector('[aria-label="执行任务与评估要求"]')?.textContent).toContain('Execute');
    expect(screen.container.querySelector('[aria-label="Workspace"]')).toBeNull();
    expect(screen.container.querySelector('select')).toBeNull();
    expect(screen.container.querySelector('[aria-label="评估数值"]')?.textContent).toContain('正确性');
    expect(screen.container.querySelector('[aria-label="评估数值"]')?.textContent).toContain('是');
    expect(screen.container.querySelector('[aria-label="评估说明全文"]')?.getAttribute('tabindex')).toBe('0');
    expect([...screen.container.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual(['结果', '执行过程', '评估过程', '资源统计']);
    await click(button('在「执行过程」中与会话对照查看'));
    await vi.waitFor(() => expect(button('preview:/index.html')).toBeDefined());
    expect(api.tree).toHaveBeenCalledWith('project', 'samplings', 'sampling', expect.any(AbortSignal));
    expect(api.messages).toHaveBeenCalledWith('project', 'samplings', 'sampling', expect.any(AbortSignal));
    expect(screen.container.textContent).toContain('agent conversation');
    expect(screen.container.querySelector('[aria-label="Workspace"]')?.textContent).toContain('1 个已收集产物');
    await click(button('preview:/index.html'));
    expect(api.file).toHaveBeenCalledWith('project', 'samplings', 'sampling', '/index.html', expect.any(AbortSignal));
    await click(button('notes.json'));
    expect(button('preview:/notes.json')).toBeDefined();
    expect(screen.container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    await act(async () => { button('结果')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); });
    await click(button('/evidence/artifacts/index.html'));
    await vi.waitFor(() => expect(button('preview:/evidence/artifacts/index.html')).toBeDefined());
    expect(screen.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('评估过程');
    expect(api.messages).toHaveBeenCalledWith('project', 'evaluations', 'evaluation', expect.any(AbortSignal));
    await click(button('preview:/evidence/artifacts/index.html'));
    expect(api.file).toHaveBeenCalledWith('project', 'evaluations', 'evaluation', '/evidence/artifacts/index.html', expect.any(AbortSignal));
    await click(button('查看原始轨迹'));
    expect(document.body.textContent).toContain('评估 Agent · 原始轨迹');
    expect(document.body.textContent).toContain('原始 Pi 记录用于排查运行细节');
    expect(document.body.textContent).toContain('trace:evaluations:evaluation');
    await click([...document.querySelectorAll('button')].find((node) => node.textContent === '返回会话'));
    expect(document.body.textContent).not.toContain('trace:evaluations:evaluation');
  } finally { await screen.unmount(); client.clear(); }
});
