import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/api-sdk/client";
import type { ProjectOverview, ProjectView } from "@/api-sdk/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { metricSummary, resourceStatistics } from "@/test/metrics";
import { click, render, select } from "@/test/render";
import { ProjectDetailPage } from "./project-detail-page";
import { ProjectResultsDownloadButton } from "./project-results-download-button";

const mocks = vi.hoisted(() => ({
  project: vi.fn(), download: vi.fn(), overview: vi.fn(), toastError: vi.fn(), navigate: vi.fn(),
}));
vi.mock("@/api-sdk/projects-api", async (original) => ({
  ...await original<object>(), getProject: mocks.project, downloadProjectEvaluationResults: mocks.download,
}));
vi.mock("@/api-sdk/metrics-api", async (original) => ({
  ...await original<object>(), getProjectOverview: mocks.overview,
}));
vi.mock("@/api-sdk/runs-api", async (original) => ({
  ...await original<object>(),
  getProjectRun: async (_projectId: string, runId: string) => ({
    run: { runId, status: "running", phase: "execution", operation: "execution" },
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));

const projectId = "project /中文?#%";
const zip = new Blob(["PK\u0003\u0004archive bytes"], { type: "application/zip" });
const urls = { create: vi.fn<(blob: Blob) => string>(), revoke: vi.fn() };
const saved: { name: string; href: string }[] = [];

function project(currentRun: ProjectView["currentRun"] = null): ProjectView {
  return {
    project: { projectId, ownerUserId: "owner", name: "项目", sourceBranch: "eval", createdAt: "2026-10-21T00:00:00Z" },
    currentRun, runSequence: 1, executionPlanDigest: "execution-digest", evaluation: null,
    datasets: [{ datasetId: "dataset", name: "数据集", kind: "general", projectSampleIds: [] }],
    projectSamples: [],
    execution: {
      harness: { kind: "sp", framework: "sp", agentConfig: { ownerUserId: "owner", userAgentId: "agent" } },
      subjectAgentConfig: { sourceUserAgentId: "source", name: "执行 Agent", body: {} },
      executionConcurrency: 1, retryPolicy: { maxRestarts: 0, initialBackoffMs: 250, maxBackoffMs: 10_000 },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function page() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = await render(
    <TooltipProvider><QueryClientProvider client={client}><ProjectDetailPage projectId={projectId} /></QueryClientProvider></TooltipProvider>,
  );
  await flush();
  return { ...view, close: async () => { await view.unmount(); client.clear(); } };
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const element = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!element) throw new Error(`Button not found: ${text}`);
  return element;
}

async function switchTab(container: HTMLElement, text: string) {
  await act(async () => {
    button(container, text).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(text);
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.project.mockResolvedValue(project());
  mocks.overview.mockResolvedValue(null);
  mocks.download.mockResolvedValue(zip);
  urls.create.mockReset().mockReturnValue("blob:project-results");
  urls.revoke.mockReset();
  saved.length = 0;
  vi.stubGlobal("URL", class extends URL { static createObjectURL = urls.create; static revokeObjectURL = urls.revoke; });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, href: this.href });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("saves the ZIP only after success, shows loading, and blocks duplicate clicks in the same event batch", async () => {
  const request = deferred<Blob>();
  mocks.download.mockReturnValue(request.promise);
  const view = await render(<ProjectResultsDownloadButton projectId={projectId} disabled={false} />);
  try {
    const download = button(view.container, "下载评估结果");
    expect(download.disabled).toBe(false);
    expect(download.querySelector(".lucide-download")).not.toBeNull();
    await act(async () => { download.click(); download.click(); });

    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(download.disabled).toBe(true);
    expect(download.textContent).toBe("下载中…");
    expect(download.querySelector(".animate-spin")).not.toBeNull();
    await click(download);
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(urls.create).not.toHaveBeenCalled();
    expect(saved).toEqual([]);

    await act(async () => request.resolve(zip));
    expect(download.disabled).toBe(false);
    expect(download.textContent).toBe("下载评估结果");
    expect(urls.create).toHaveBeenCalledOnce();
    const savedZip = urls.create.mock.calls[0]![0];
    expect(savedZip.type).toBe("application/zip");
    const content = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(savedZip);
    });
    expect(content).toBe("PK\u0003\u0004archive bytes");
    expect(saved).toEqual([{
      name: `project-${encodeURIComponent(projectId)}-evaluation-results.zip`, href: "blob:project-results",
    }]);
    expect(urls.revoke).toHaveBeenCalledExactlyOnceWith("blob:project-results");
    expect(mocks.toastError).not.toHaveBeenCalled();
  } finally { await view.unmount(); }
});

it("places the compact secondary download action immediately before the existing run action", async () => {
  const view = await page();
  try {
    const header = view.container.querySelector("header")!;
    const actions = [...header.querySelectorAll("button")];
    expect(actions.slice(0, 2).map((action) => action.textContent)).toEqual(["下载评估结果", "运行 / 重新评估"]);
    const download = button(header, "下载评估结果");
    expect(download.nextElementSibling?.contains(button(header, "运行 / 重新评估"))).toBe(true);
    expect(download.className).toContain("h-8");
    expect(download.className).toContain("bg-surface");
    expect(download.disabled).toBe(false);
  } finally { await view.close(); }
});

it("disables download until the Project has successfully loaded", async () => {
  const request = deferred<ProjectView>();
  mocks.project.mockReturnValue(request.promise);
  const view = await page();
  try {
    const download = button(view.container, "下载评估结果");
    expect(download.disabled).toBe(true);
    await click(download);
    expect(mocks.download).not.toHaveBeenCalled();

    await act(async () => request.resolve(project()));
    await flush();
    expect(download.disabled).toBe(false);
  } finally { await view.close(); }
});

it("keeps download disabled when the Project failed to load", async () => {
  mocks.project.mockRejectedValue(new ApiError({ kind: "http", status: 404, code: "PROJECT_NOT_FOUND", message: "missing" }));
  const view = await page();
  try {
    expect(view.container.textContent).toContain("Project 不存在或已删除");
    const download = button(view.container, "下载评估结果");
    expect(download.disabled).toBe(true);
    await click(download);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  } finally { await view.close(); }
});

it("shows a safe error without saving a ZIP or changing the page, and permits an explicit retry", async () => {
  mocks.download.mockRejectedValueOnce(new ApiError({
    kind: "http", status: 503, code: "DATABASE_UNAVAILABLE", message: "private database detail",
  }));
  const view = await page();
  try {
    await switchTab(view.container, "项目设置");
    const download = button(view.container, "下载评估结果");
    await click(download);

    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith("数据库暂时不可用，请稍后重试");
    expect(urls.create).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(download.disabled).toBe(false);
    expect(download.textContent).toBe("下载评估结果");
    expect(view.container.querySelector("h1")?.textContent).toBe("项目");
    expect(view.container.textContent).toContain("项目使用创建时的数据副本");
    expect(view.container.textContent).not.toContain("private database detail");
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.download).toHaveBeenCalledOnce();

    await click(download);
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(saved).toHaveLength(1);
    expect(mocks.toastError).toHaveBeenCalledOnce();
  } finally { await view.close(); }
});

it("allows a download while a Run is active even though the run action is disabled", async () => {
  mocks.project.mockResolvedValue(project({ runId: "active-run" }));
  const view = await page();
  try {
    expect(button(view.container, "运行 / 重新评估").disabled).toBe(true);
    const download = button(view.container, "下载评估结果");
    expect(download.disabled).toBe(false);
    await click(download);
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(saved).toHaveLength(1);
    expect(button(view.container, "停止")).toBeDefined();
  } finally { await view.close(); }
});

it("downloads the whole Project independently of dataset, result, metric, and tab filters", async () => {
  const summary = metricSummary(resourceStatistics(), resourceStatistics());
  const overview: ProjectOverview = {
    project: project().project, runIds: [], datasets: [], projectSamples: [],
    summary: { ...summary, evaluationOutputs: { ...summary.evaluationOutputs, fields: [{
      jsonPointer: "/score", title: "分数", description: "", kinds: ["number"], observationCount: 0,
      contributingEvaluationCount: 0, missingEvaluationCount: 1, coverage: "unavailable", diagnostics: [], distribution: [], numeric: null,
    }] } },
  };
  mocks.overview.mockResolvedValue(overview);
  const view = await page();
  try {
    await select(view.container.querySelector('[aria-label="数据集筛选"]'), "dataset");
    await select(view.container.querySelector('[aria-label="结果筛选"]'), "not-run");
    await select(view.container.querySelector('[aria-label="评估指标"]'), "/score");
    await click(button(view.container, "下载评估结果"));
    expect((view.container.querySelector('[aria-label="数据集筛选"]') as HTMLSelectElement).value).toBe("dataset");
    expect((view.container.querySelector('[aria-label="结果筛选"]') as HTMLSelectElement).value).toBe("not-run");
    expect((view.container.querySelector('[aria-label="评估指标"]') as HTMLSelectElement).value).toBe("/score");
    await switchTab(view.container, "运行记录");
    await click(button(view.container, "下载评估结果"));
    await switchTab(view.container, "项目设置");
    await click(button(view.container, "下载评估结果"));

    expect(mocks.download.mock.calls).toEqual([[projectId], [projectId], [projectId]]);
    expect(saved).toHaveLength(3);
  } finally { await view.close(); }
});
