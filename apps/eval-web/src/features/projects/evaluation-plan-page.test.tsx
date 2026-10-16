import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@springbrand/http/client";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { projectKeys } from "@/api-sdk/projects-api";
import { click, render, select, type } from "@/test/render";
import { EvaluationPlanPage } from "./evaluation-plan-page";

const mocks = vi.hoisted(() => ({ project: vi.fn(), save: vi.fn(), navigate: vi.fn() }));
vi.mock("@/api-sdk/projects-api", async (original) => ({ ...await original<object>(), getProject: mocks.project, replaceEvaluationPlan: mocks.save }));
vi.mock("@/api-sdk/agent-configs-api", async (original) => ({ ...await original<object>(), listAgentOptions: async () => [{ name: "评估 Agent", agentConfig: { userAgentId: "evaluator" } }] }));
vi.mock("@/api-sdk/output-schemas-api", async (original) => ({ ...await original<object>(), listOutputSchemas: async () => [{ outputSchemaId: "schema", name: "评分" }] }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate, Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

function project(lockedAt: string | null = null) {
  return { project: { projectId: "project", name: "项目" }, currentRun: { runId: "execution" },
    evaluation: { lockedAt, plan: { evaluatorAgentConfig: { sourceUserAgentId: "evaluator", name: "评估 Agent" }, evaluationConcurrency: 2, outputSchema: { outputSchemaId: "schema" } } } };
}
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
const control = (container: HTMLElement, text: string) => document.getElementById([...container.querySelectorAll("label")].find((item) => item.textContent === text)!.htmlFor)!;
const saveButton = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "保存")!;
beforeEach(() => { mocks.project.mockReset(); mocks.save.mockReset(); mocks.navigate.mockReset(); mocks.project.mockResolvedValue(project()); mocks.save.mockResolvedValue(project()); });

async function page() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><EvaluationPlanPage projectId="project" /></QueryClientProvider></TooltipProvider>);
  await flush(); await flush();
  return { ...view, client, close: async () => { await view.unmount(); client.clear(); } };
}

it("edits evaluation settings while an execution-only Run is active", async () => {
  const view = await page();
  try {
    await type(control(view.container, "评估并发"), "7");
    await select(control(view.container, "评分 Schema"), "schema");
    expect(saveButton(view.container).disabled).toBe(false);
    await click(saveButton(view.container)); await flush();
    expect(mocks.save).toHaveBeenCalledWith("project", { userAgentId: "evaluator", evaluationConcurrency: 7, outputSchemaId: "schema" });
  } finally { await view.close(); }
});

it("reconciles a first-evaluation race to the returned read-only plan", async () => {
  mocks.save.mockImplementation(async () => {
    mocks.project.mockResolvedValue(project("2026-10-15T00:00:00Z"));
    throw new ApiError({ kind: "http", code: "PROJECT_EVALUATION_PLAN_LOCKED", status: 409, message: "locked" });
  });
  const view = await page();
  try {
    await click(saveButton(view.container)); await flush();
    expect(saveButton(view.container)).toBeUndefined();
    expect(view.container.textContent).toContain("当前评估计划");
    expect(view.container.querySelector("input")).toBeNull();
  } finally { await view.close(); }
});

it("retains the edited draft when a background read fails and recovers", async () => {
  const view = await page();
  try {
    await type(control(view.container, "评估并发"), "9");
    mocks.project.mockRejectedValueOnce(new ApiError({ kind: "network", code: "NETWORK_ERROR", status: 0, message: "lost" }));
    await act(async () => { await view.client.invalidateQueries({ queryKey: projectKeys.detail("project") }); }); await flush();
    expect((control(view.container, "评估并发") as HTMLInputElement).value).toBe("9");
    await act(async () => { await view.client.invalidateQueries({ queryKey: projectKeys.detail("project") }); }); await flush();
    expect((control(view.container, "评估并发") as HTMLInputElement).value).toBe("9");
  } finally { await view.close(); }
});
