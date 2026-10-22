import type { AgentImportCandidate, AgentImportPreview, AgentImportTaskView } from "@eval-platform/eval-contracts";
import { createAgentEditorClient, skillQueryKeys, userReferenceQueryKeys } from "@springbrand/agent-config-editor/client";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentKeys } from "@/api-sdk/agent-configs-api";
import { ApiError } from "@/api-sdk/client";
import { meKey } from "@/api-sdk/session-api";
import type { AgentConfig } from "@/api-sdk/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { click, render, select, type } from "@/test/render";
import { agentImportPointerKey } from "./agent-import-pointer";
import { AGENT_IMPORT_POLL_MS, agentImportKeys } from "./agent-import-state";
import { AgentsPage } from "./agents-page";

const transport = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), request: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("@/api-sdk/client", async (original) => ({ ...await original<object>(), api: transport }));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER_A = uuid(101), USER_B = uuid(102), TARGET = uuid(900);
const users = [
  { id: USER_A, name: "Dev Alice", email: "alice@example.test" },
  { id: USER_B, name: "Dev Bob", email: "bob@example.test" },
];
const base = "/api/agent-config-sync";
const native: AgentConfig = {
  id: uuid(800), user_id: TARGET, slug: "native", name: "Eval 原生配置", description: "独立于 dev 的配置",
  revision: 1, setting_schema_version: 4, is_default: false, created_at: 1, updated_at: 1,
  setting: {
    model: null, presetId: null, thinking: "medium", systemPrompt: "Native instructions",
    skillIds: [], actionIds: [], referenceFileIds: [], mcpServers: [], connectorIds: [], extensionIds: [], subagentNames: [],
    toolPolicy: { allow: [], deny: [] }, executionLevel: "safe", sandbox: { enabled: false },
    memoryDefaults: { enabled: false, memoryTokens: 100, preferencesTokens: 50 },
  },
};
function candidate(n: number, exists = false): AgentImportCandidate {
  return { id: uuid(n), name: `Agent ${n}`, description: `Description ${n}`, revision: 3, skillCount: 2, referenceCount: 1, exists };
}
let enabled: boolean, maxAgents: number, previewStatus: AgentImportTaskView["status"], sequence: number, targetUserId: string;
let task: AgentImportTaskView | null;
let userRead: ((params: Record<string, unknown>) => unknown) | null;
let candidateRead: ((userId: string, params: Record<string, unknown>) => unknown) | null;
const mounted: { unmount: () => Promise<void>; query: QueryClient }[] = [];
function createTask(input: AgentImportPreview): AgentImportTaskView {
  return {
    id: uuid(1000 + ++sequence), sourceUserId: input.sourceUserId, purpose: input.purpose, status: previewStatus,
    agents: input.agentIds.map((id) => ({ id, name: `Agent ${Number(id.slice(-12))}`, status: "ready", overwrite: id === uuid(20), skillCount: 2, referenceCount: 1 })),
    progress: { stage: "checking", completed: input.agentIds.length, total: input.agentIds.length, bytesRead: 40, totalBytes: 100 },
    summary: { created: 0, skipped: 0, failed: 0, conflicts: 0 }, expiresAt: "2099-01-01T00:00:00.000Z",
  };
}
function button(label: string, within: ParentNode = document) {
  const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function modal() {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error("Import dialog not open");
  return found;
}
function userSelect() {
  const found = modal().querySelector<HTMLSelectElement>('select[aria-label="选择 dev 用户"]');
  if (!found) throw new Error("User dropdown not found");
  return found;
}
function userOptions() { return [...userSelect().options].filter((option) => option.value !== ""); }
async function settle(check: () => void) {
  let failure: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // Each act must finish to flush the effects that bind the verified identity and task.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    try { check(); return; } catch (error) { failure = error; }
  }
  throw failure;
}
function candidateCalls() { return transport.get.mock.calls.filter(([path]) => /^\/api\/agent-config-sync\/users\/[^/]+\/agents$/u.test(path)); }
function userCalls() { return transport.get.mock.calls.filter(([path]) => path === `${base}/users`); }
function taskCalls() { return transport.get.mock.calls.filter(([path]) => path.startsWith(`${base}/tasks/`)); }
async function mount(query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  const root = createRootRoute({ component: Outlet });
  const list = createRoute({ getParentRoute: () => root, path: "/agents", component: AgentsPage });
  const create = createRoute({ getParentRoute: () => root, path: "/agents/new", component: () => <p>Agent 创建页</p> });
  const router = createRouter({ routeTree: root.addChildren([list, create]), history: createMemoryHistory({ initialEntries: ["/agents"] }) });
  const view = await render(<TooltipProvider><QueryClientProvider client={query}><RouterProvider router={router} /></QueryClientProvider></TooltipProvider>);
  mounted.push({ ...view, query });
  await settle(() => expect(view.container.textContent).toContain("Eval 原生配置"));
  return { ...view, query, router };
}
async function open() {
  await click(button("从 dev 导入"));
  await settle(() => expect(modal().textContent).toContain(enabled ? "Dev Alice" : "当前环境尚未启用"));
}
async function chooseUser(id = USER_A) {
  await select(userSelect(), id);
  await settle(() => expect(modal().querySelector('[aria-label="dev 用户的候选 Agent"]')).not.toBeNull());
}
async function chooseAgent(n: number) {
  await click(modal().querySelector(`[role="checkbox"][aria-label="选择 Agent Agent ${n}（${uuid(n)}）"]`));
}
async function preview() {
  await click(button("检查所选依赖", modal()));
  await settle(() => expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).not.toBeNull());
}
async function confirm(count: number) {
  await click(button(`确认导入 ${count} 个 Agent`, modal()));
  await settle(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
  await click(button("开始后台导入", document.querySelector('[role="alertdialog"]')!));
  await settle(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
}
async function poll() {
  await act(async () => { await vi.advanceTimersByTimeAsync(AGENT_IMPORT_POLL_MS); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}
async function leave(view: { query: QueryClient }) {
  const index = mounted.findIndex((item) => item.query === view.query);
  const [mountedView] = mounted.splice(index, 1);
  await mountedView!.unmount();
  mountedView!.query.clear();
}
async function reopenPersisted() {
  const view = await mount();
  await click(button("从 dev 导入"));
  await settle(() => expect(modal().textContent).toContain("已从服务端恢复原任务"));
  return view;
}
function persistedTask(status: AgentImportTaskView["status"] = "importing") {
  task = createTask({ sourceUserId: USER_A, agentIds: [uuid(1)], purpose: "evaluation", idempotencyKey: "server-fixture" });
  task.status = status;
  window.localStorage.setItem(agentImportPointerKey(TARGET), JSON.stringify({ taskId: task.id }));
  return task;
}

describe("dev Agent import user workflow", () => {
  beforeEach(() => {
    for (const mock of Object.values(transport)) mock.mockReset();
    window.localStorage.clear();
    enabled = true; maxAgents = 50; previewStatus = "ready"; sequence = 0; task = null; userRead = null; candidateRead = null;
    targetUserId = TARGET;
    window.scrollTo = vi.fn();
    transport.get.mockImplementation(async (path: string, options?: { params?: Record<string, unknown> }) => {
      if (path === "/api/agent-configs") return [{ ...native, origin: "eval_native", sourceConnectionId: "INTERNAL_CONNECTION" }];
      if (path === "/api/agents") return [{ agentConfig: { ownerUserId: TARGET, userAgentId: native.id }, name: native.name, role: "subject", purpose: "execution" }];
      if (path === "/api/me") return { id: targetUserId, role: "user" };
      if (path === `${base}/config`) return { enabled, maxAgents };
      if (path === `${base}/users`) return userRead ? userRead(options?.params ?? {}) : { users, nextCursor: null };
      if (path.startsWith(`${base}/tasks/`)) {
        if (!task || path !== `${base}/tasks/${task.id}`) throw new Error("Task not found");
        return structuredClone(task);
      }
      const match = path.match(/^\/api\/agent-config-sync\/users\/([^/]+)\/agents$/u);
      if (match) {
        if (candidateRead) return candidateRead(match[1]!, options?.params ?? {});
        if (options?.params?.q) return { items: [candidate(80)], nextCursor: null };
        if (match[1] === USER_B) return { items: [candidate(41)], nextCursor: null };
        return options?.params?.cursor === "page-2"
          ? { items: [candidate(21), candidate(22)], nextCursor: null }
          : { items: Array.from({ length: 20 }, (_, index) => candidate(index + 1, index === 19)), nextCursor: "page-2" };
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    transport.request.mockImplementation(async (path: string) => {
      if (path === "/api/agent-library/models") return [];
      throw new Error(`Unexpected library request ${path}`);
    });
    transport.post.mockImplementation(async (path: string, input: unknown) => {
      if (path === `${base}/previews`) {
        task = createTask(input as AgentImportPreview);
        return { taskId: task.id };
      }
      if (task && path === `${base}/tasks/${task.id}/apply`) {
        task = { ...task, status: "queued", progress: { ...task.progress, stage: "queued", completed: 0 } };
        return { taskId: task.id };
      }
      throw new Error(`Unexpected POST ${path}`);
    });
  });
  afterEach(async () => {
    for (const view of mounted.splice(0)) { await view.unmount(); view.query.clear(); }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("offers a username dropdown without a search input and never loads Agents before selection", async () => {
    await mount();
    expect(userCalls()).toHaveLength(0);
    await click(button("从 dev 导入"));
    await settle(() => expect(modal().textContent).toContain("Dev Alice"));
    expect(modal().querySelector('input[type="search"]')).toBeNull();
    expect(userCalls()).toHaveLength(1);
    expect(userCalls()[0]![1]).toEqual({ params: { limit: 20 }, signal: expect.any(AbortSignal) });
    const picker = modal().querySelector<HTMLSelectElement>('select[aria-label="选择 dev 用户"]');
    expect(picker).toBeInstanceOf(HTMLSelectElement);
    expect([...picker!.options].map((option) => option.textContent)).toEqual(["请选择 dev 用户", "Dev Alice", "Dev Bob"]);
    expect(picker!.value).toBe("");
    expect(modal().querySelector('input[name="agent-import-user"]')).toBeNull();
    expect(modal().textContent).not.toMatch(/alice@example|bob@example|00000000|已授权用户|请先输入|最多显示 20/u);
    expect(candidateCalls()).toHaveLength(0);
    await chooseUser(USER_B);
    expect(modal().textContent).toContain("已选用户：Dev Bob");
    expect(modal().textContent).not.toMatch(/alice@example|bob@example|00000000-0000-4000-8000-00000000010[12]/u);
    expect(candidateCalls()).toHaveLength(1);
  });

  it("does not fetch Agents until a user is chosen, and keeps Agent search on the server", async () => {
    const view = await mount();
    expect(candidateCalls()).toHaveLength(0);
    expect(transport.get.mock.calls.some(([path]) => path.startsWith(base))).toBe(false);
    await open();
    expect(candidateCalls()).toHaveLength(0);
    expect(modal().textContent).toContain("请先选择 dev 用户");
    await chooseUser(USER_B);
    expect(candidateCalls().at(-1)).toEqual([`${base}/users/${USER_B}/agents`, expect.objectContaining({ params: { q: "", limit: 20 } })]);
    await type(modal().querySelector('[aria-label="搜索 dev Agent"]'), "搜索内容");
    await settle(() => expect(modal().textContent).toContain("Agent 80"));
    expect(candidateCalls().at(-1)![1].params).toEqual({ q: "搜索内容", limit: 20 });
    expect(view.container.querySelector("tbody")?.textContent).toContain("Eval 原生配置");
  });

  it("adds an official option to the same dropdown and preserves its source ID through preview and confirmation", async () => {
    const official = { id: "springbrand-official", name: "SpringBrand", email: "official@example.test", official: true };
    userRead = () => ({ users: [official, ...users], nextCursor: null });
    candidateRead = () => ({ items: [candidate(1)], nextCursor: null });
    await mount(); await open();
    expect(userOptions().map((option) => option.textContent)).toEqual(["官方", "Dev Alice", "Dev Bob"]);
    expect(modal().querySelector('input[type="search"]')).toBeNull();
    await chooseUser(official.id); await chooseAgent(1); await preview();
    expect(transport.post.mock.calls[0]![1]).toMatchObject({ sourceUserId: official.id, agentIds: [uuid(1)] });
    expect(modal().textContent).toContain("本次 dev 用户：官方");
    await click(button("确认导入 1 个 Agent", modal()));
    const confirmation = document.querySelector('[role="alertdialog"]')!;
    expect(confirmation.textContent).toContain("本次 dev 用户：官方");
    expect(confirmation.textContent).not.toContain(official.email);
    expect(transport.post.mock.calls.filter(([path]) => path.endsWith("/apply"))).toHaveLength(0);
  });

  it("appends user pages beyond 20 while retaining the selected user and preview until a user switch", async () => {
    const laterUser = { id: uuid(121), name: "Dev User 21", email: "user21@example.test" };
    const firstPage = [...users, ...Array.from({ length: 18 }, (_, index) => ({
      id: uuid(103 + index), name: `Dev User ${index + 3}`, email: `user${index + 3}@example.test`,
    }))];
    userRead = (params) => params.cursor === "user-page-2"
      ? { users: [laterUser], nextCursor: null } : { users: firstPage, nextCursor: "user-page-2" };
    candidateRead = (id) => ({ items: [candidate(id === laterUser.id ? 61 : 1)], nextCursor: null });
    await mount(); await open(); await chooseUser(); await chooseAgent(1); await preview();
    const originalTaskId = task!.id;
    expect(userOptions()).toHaveLength(20);
    expect(modal().textContent).not.toContain("Dev User 21");
    const readsBeforeMore = userCalls().length;
    expect(userCalls().every(([, options]) => options.params.cursor === undefined)).toBe(true);
    await click(button("加载更多用户", modal()));
    await settle(() => expect(modal().textContent).toContain("Dev User 21"));
    expect(userOptions()).toHaveLength(21);
    expect(userCalls()).toHaveLength(readsBeforeMore + 1);
    expect(userCalls().at(-1)![1].params).toEqual({ limit: 20, cursor: "user-page-2" });
    expect(userSelect().value).toBe(USER_A);
    expect(modal().textContent).toContain("已选用户：Dev Alice");
    expect(modal().textContent).toContain("已选 1 / 50");
    expect(modal().querySelector(`[role="checkbox"][aria-label="选择 Agent Agent 1（${uuid(1)}）"]`)?.getAttribute("aria-checked")).toBe("true");
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).not.toBeNull();
    expect(modal().textContent).toContain(originalTaskId);
    expect([...modal().querySelectorAll("button")].some((item) => item.textContent === "加载更多用户")).toBe(false);
    await chooseUser(laterUser.id);
    expect(modal().textContent).toContain("已选用户：Dev User 21");
    expect(modal().textContent).toContain("已选 0 / 50");
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).toBeNull();
    expect(window.localStorage.getItem(agentImportPointerKey(TARGET))).toBeNull();
    await chooseAgent(61); await preview();
    expect(transport.post.mock.calls[1]![1]).toMatchObject({ sourceUserId: laterUser.id, agentIds: [uuid(61)] });
    expect(modal().textContent).not.toContain(laterUser.email);
  });

  it("keeps loaded usernames, the selected user, Agents and preview when a later user page fails, and retries that page", async () => {
    const laterUser = { id: uuid(121), name: "Dev User 21", email: "user21@example.test" };
    let failMore!: (error: Error) => void;
    let failing = true;
    userRead = (params) => {
      if (params.cursor !== "user-page-2") return { users, nextCursor: "user-page-2" };
      if (failing) return new Promise((_resolve, reject) => { failMore = reject; });
      return { users: [laterUser], nextCursor: null };
    };
    await mount(); await open(); await chooseUser(); await chooseAgent(1); await preview();
    const originalTaskId = task!.id;
    await settle(() => expect(button("加载更多用户", modal()).disabled).toBe(false));
    const readsBeforeMore = userCalls().length;
    await click(button("加载更多用户", modal()));
    await settle(() => expect(userCalls()).toHaveLength(readsBeforeMore + 1));
    expect(button("加载更多用户", modal()).disabled).toBe(true);
    expect(userSelect().value).toBe(USER_A);
    expect(modal().textContent).toContain("Dev Bob");
    await act(async () => failMore(new Error("更多用户暂时不可用")));
    await settle(() => expect(modal().textContent).toContain("更多用户暂时不可用"));
    expect(userOptions()).toHaveLength(2);
    expect(userSelect().value).toBe(USER_A);
    expect(modal().textContent).toContain("Dev Bob");
    expect(modal().textContent).toContain("已选用户：Dev Alice");
    expect(modal().textContent).toContain("已选 1 / 50");
    expect(modal().textContent).toContain(originalTaskId);
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).not.toBeNull();
    expect(modal().textContent).not.toContain("暂无 dev 用户");
    failing = false;
    await click(button("重试", modal()));
    await settle(() => expect(modal().textContent).toContain("Dev User 21"));
    expect(modal().textContent).not.toContain("更多用户暂时不可用");
    expect(userOptions()).toHaveLength(3);
    expect(userSelect().value).toBe(USER_A);
    expect(modal().querySelector(`[role="checkbox"][aria-label="选择 Agent Agent 1（${uuid(1)}）"]`)?.getAttribute("aria-checked")).toBe("true");
    expect(modal().textContent).toContain(originalTaskId);
    expect(userCalls().slice(readsBeforeMore).map(([, options]) => options.params)).toEqual([
      { limit: 20, cursor: "user-page-2" }, { limit: 20, cursor: "user-page-2" },
    ]);
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "", email: "private@example.test" },
    { name: " \t ", email: "private@example.test" },
    { name: "", email: "" },
  ])("uses an unnamed-user label instead of email or UUID in the picker, preview and confirmation: %j", async (user) => {
    userRead = () => ({ users: [{ id: USER_A, ...user }], nextCursor: null });
    await mount(); await click(button("从 dev 导入"));
    await settle(() => expect(modal().textContent).toContain("未命名用户"));
    expect(userOptions().map((option) => option.textContent)).toEqual(["未命名用户"]);
    expect(modal().textContent).not.toMatch(/private@example|00000000/u);
    await chooseUser(); await chooseAgent(1);
    expect(modal().textContent).toContain("已选用户：未命名用户");
    await preview();
    expect(modal().textContent).toContain("本次 dev 用户：未命名用户");
    expect(modal().textContent).not.toContain(USER_A);
    expect(modal().textContent).not.toContain("private@example.test");
    await click(button("确认导入 1 个 Agent", modal()));
    const confirmation = document.querySelector('[role="alertdialog"]')!;
    expect(confirmation.textContent).toContain("本次 dev 用户：未命名用户");
    expect(confirmation.textContent).not.toContain(USER_A);
    expect(confirmation.textContent).not.toContain("private@example.test");
  });

  it("shows initial user loading and an empty directory without requiring input or reading Agents", async () => {
    let finish!: (page: unknown) => void;
    userRead = () => new Promise((resolve) => { finish = resolve; });
    const view = await mount(); await click(button("从 dev 导入"));
    await settle(() => expect(userCalls()).toHaveLength(1));
    expect(modal().querySelector('[role="status"][aria-label="加载中"]')).not.toBeNull();
    expect(modal().querySelector('input[type="search"]')).toBeNull();
    expect(modal().textContent).not.toContain("暂无 dev 用户");
    expect(candidateCalls()).toHaveLength(0);
    await act(async () => finish({ users: [], nextCursor: null }));
    await settle(() => expect(modal().textContent).toContain("暂无 dev 用户"));
    expect(modal().querySelector('[role="status"][aria-label="加载中"]')).toBeNull();
    expect(userOptions()).toHaveLength(0);
    expect(userSelect().disabled).toBe(true);
    expect([...modal().querySelectorAll("button")].some((item) => item.textContent === "加载更多用户")).toBe(false);
    expect(button("检查所选依赖", modal()).disabled).toBe(true);
    expect(candidateCalls()).toHaveLength(0);
    expect(transport.post).not.toHaveBeenCalled();
    expect(view.container.querySelector("tbody")?.textContent).toContain("Eval 原生配置");
  });

  it("reports an initial user-directory failure and retries the first page without input or premature Agent reads", async () => {
    userRead = () => { throw new Error("用户目录暂时不可用"); };
    await mount(); await click(button("从 dev 导入"));
    await settle(() => expect(modal().textContent).toContain("用户目录暂时不可用"));
    expect(modal().querySelector('input[type="search"]')).toBeNull();
    expect(modal().querySelector('[aria-label="选择 dev 用户"]')).toBeNull();
    expect(modal().textContent).not.toContain("暂无 dev 用户");
    expect(button("检查所选依赖", modal()).disabled).toBe(true);
    expect(candidateCalls()).toHaveLength(0);
    userRead = () => ({ users, nextCursor: null });
    await click(button("重试", modal()));
    await settle(() => expect(modal().textContent).toContain("Dev Bob"));
    expect(modal().textContent).not.toContain("用户目录暂时不可用");
    expect(userCalls().map(([, options]) => options.params)).toEqual([{ limit: 20 }, { limit: 20 }]);
    expect(candidateCalls()).toHaveLength(0);
    expect(transport.post).not.toHaveBeenCalled();
    await chooseUser(USER_B);
    expect(modal().textContent).toContain("已选用户：Dev Bob");
  });

  it.each([true, false])("revalidates a fresh cached Eval identity when opening the dialog (source enabled: %s)", async (sourceEnabled) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 22));
    enabled = sourceEnabled;
    const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 10_000 } } });
    query.setQueryData(meKey, { id: TARGET, role: "user" });
    await mount(query);
    expect(transport.get.mock.calls.some(([path]) => path === "/api/me")).toBe(false);
    await click(button("从 dev 导入"));
    await settle(() => expect(modal().textContent).toContain(enabled
      ? "Dev Alice" : "当前环境尚未启用 dev 导入"));
    expect(modal().textContent).not.toContain("正在确认 Eval 账号并只读恢复任务定位信息");
    expect(transport.get.mock.calls.filter(([path]) => path === "/api/me")).toHaveLength(1);
    expect(taskCalls()).toHaveLength(0);
    expect(candidateCalls()).toHaveLength(0);
    expect(userCalls()).toHaveLength(enabled ? 1 : 0);
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("keeps a disabled source isolated from the ordinary native list, filters and creation", async () => {
    enabled = false;
    const view = await mount();
    const tableBefore = view.container.querySelector("table")!.textContent;
    await open();
    expect(modal().textContent).toContain("普通 Agent 的新建、列表和编辑不受影响");
    expect(candidateCalls()).toHaveLength(0);
    expect(transport.get.mock.calls.some(([path]) => path === `${base}/users`)).toBe(false);
    expect(transport.get.mock.calls.some(([path]) => path === "/api/me")).toBe(true); // Identity is needed to look up a safe recovery pointer.
    expect(modal().querySelector('[aria-label="选择 dev 用户"]')).toBeNull();
    await click(button("关闭", modal()));
    expect(view.container.querySelector("table")!.textContent).toBe(tableBefore);
    expect(view.container.textContent).not.toMatch(/eval_native|dev_import|INTERNAL_CONNECTION|alice@example/u);
    expect([...view.container.querySelectorAll("th")].map((head) => head.textContent)).not.toContain("来源");
    expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(3);
    await click(button("新建 Agent", view.container));
    await settle(() => expect(view.container.textContent).toContain("Agent 创建页"));
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("selects new and existing IDs on the current page and preserves the explicit cross-page set", async () => {
    const view = await mount();
    const evaluationTab = [...view.container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith("评估 Agent"));
    await click(evaluationTab);
    await open();
    expect(modal().querySelector<HTMLInputElement>('input[name="agent-import-purpose"][value="execution"]')?.checked).toBe(true);
    await chooseUser();
    expect(modal().querySelectorAll('[aria-label="dev 用户的候选 Agent"] tbody tr')).toHaveLength(20);
    expect(modal().querySelector(`[role="checkbox"][aria-label="选择 Agent Agent 20（${uuid(20)}）"]`)).toHaveProperty("disabled", false);
    await click(modal().querySelector('[role="checkbox"]'));
    expect(modal().textContent).toContain("已选 20 / 50 个（跨页保留，本页已选 20 个）");
    await click(button("下一页", modal()));
    await settle(() => expect(modal().textContent).toContain("第 2 页"));
    await settle(() => expect(modal().querySelectorAll('[aria-label="dev 用户的候选 Agent"] tbody tr')).toHaveLength(2));
    expect(modal().querySelector('[aria-label="dev 用户的候选 Agent"]')?.textContent).not.toContain("Agent 1");
    expect(candidateCalls().at(-1)![1].params).toEqual({ q: "", cursor: "page-2", limit: 20 });
    expect(modal().textContent).toContain("跨页保留，本页已选 0 个");
    await chooseAgent(21);
    expect(modal().textContent).toContain("已选 21 / 50 个（跨页保留，本页已选 1 个）");
    await click(button("上一页", modal()));
    await settle(() => expect(modal().querySelectorAll('[aria-label="dev 用户的候选 Agent"] tbody tr')).toHaveLength(20));
    expect(modal().querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
    expect(modal().querySelector("details")?.textContent).toContain("Agent 21");
    await click(modal().querySelector('input[name="agent-import-purpose"][value="evaluation"]'));
    await preview();
    const input = transport.post.mock.calls[0]![1] as AgentImportPreview;
    expect(input).toEqual({
      sourceUserId: USER_A, purpose: "evaluation", idempotencyKey: expect.any(String),
      agentIds: [...Array.from({ length: 20 }, (_, index) => uuid(index + 1)), uuid(21)].sort(),
    });
    expect(input.agentIds).toContain(uuid(20));
    expect(input.agentIds).not.toContain(uuid(22));
    expect(input.agentIds).not.toContain(native.id);
    expect(modal().textContent).toContain("所选 Agent 21");
    expect(modal().textContent).toContain("每行依赖数量可能重叠，不合计为去重资源数");
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it("warns before overwriting a selected existing ID and displays its overwrite result", async () => {
    await mount(); await open(); await chooseUser();
    expect(modal().textContent).toContain("已存在，导入将覆盖");
    await chooseAgent(20); await preview();
    await click(button("确认导入 1 个 Agent", modal()));
    const confirmation = document.querySelector('[role="alertdialog"]')!;
    expect(confirmation.textContent).toContain("同 ID 的 Agent、Skill、参考资料会被覆盖");
    expect(transport.post.mock.calls.filter(([path]) => path.endsWith("/apply"))).toHaveLength(0);
    await click(button("开始后台导入", confirmation));
    await settle(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    task = { ...task!, status: "completed", agents: task!.agents.map((agent) => ({ ...agent, status: "overwritten" })),
      summary: { created: 0, overwritten: 1, skipped: 0, failed: 0, conflicts: 0 } };
    await click(button("刷新任务状态", modal()));
    await settle(() => expect(modal().textContent).toContain("已覆盖 1"));
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')?.textContent).toContain("已覆盖");
  });

  it("clears selection and preview on a user switch and ignores the old task's late read", async () => {
    await mount(); await open(); await chooseUser(); await chooseAgent(1); await preview();
    const oldTask = structuredClone(task!);
    expect(JSON.parse(window.localStorage.getItem(agentImportPointerKey(TARGET))!)).toEqual({ taskId: oldTask.id });
    const original = transport.get.getMockImplementation()!;
    let finishOld!: (value: AgentImportTaskView) => void;
    transport.get.mockImplementation((path: string, options?: unknown) => path === `${base}/tasks/${oldTask.id}`
      ? new Promise<AgentImportTaskView>((resolve) => { finishOld = resolve; }) : original(path, options));
    await click(button("刷新任务状态", modal()));
    await chooseUser(USER_B);
    expect(window.localStorage.getItem(agentImportPointerKey(TARGET))).toBeNull();
    expect(modal().textContent).toContain("已选 0 / 50");
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).toBeNull();
    expect(button("检查所选依赖", modal()).disabled).toBe(true);
    await chooseAgent(41);
    await act(async () => finishOld(oldTask));
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).toBeNull();
    expect(modal().querySelector("details")?.textContent).toContain("Agent 41");
    expect(modal().querySelector("details")?.textContent).not.toContain("Agent 1");
    await preview();
    expect(transport.post.mock.calls[1]).toEqual([`${base}/previews`, {
      sourceUserId: USER_B, purpose: "execution", agentIds: [uuid(41)], idempotencyKey: expect.any(String),
    }]);
    expect(transport.post.mock.calls.every(([path]) => path === `${base}/previews`)).toBe(true);
  });

  it("blocks a task whose source user does not match the current captured preview", async () => {
    await mount(); await open(); await chooseUser(); await chooseAgent(1); await preview();
    task = { ...task!, sourceUserId: USER_B };
    await click(button("刷新任务状态", modal()));
    await settle(() => expect(modal().textContent).toContain("已阻止确认"));
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).toBeNull();
    expect([...modal().querySelectorAll("button")].some((item) => item.textContent?.startsWith("确认导入"))).toBe(false);
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it("keeps a fixed preview request/key on explicit recovery without automatically repeating POST", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await mount(); await open(); await chooseUser(); await chooseAgent(1);
    transport.post.mockRejectedValueOnce(new ApiError({ kind: "network", code: "NETWORK_ERROR", status: 0, message: "ack lost" }));
    await click(button("检查所选依赖", modal()));
    await settle(() => expect(modal().textContent).toContain("检查请求的响应未确认"));
    const first = transport.post.mock.calls[0]![1];
    await poll(); await poll();
    expect(transport.post).toHaveBeenCalledTimes(1);
    await click(button("使用原请求重试检查", modal()));
    await settle(() => expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).not.toBeNull());
    expect(transport.post.mock.calls[1]).toEqual([`${base}/previews`, first]);
    expect(transport.post.mock.calls[1]![1]).toBe(first);
  });

  it("locks an uncertain apply to the original task and key across close/reopen and explicit confirmation retry", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await mount(); await open(); await chooseUser(); await chooseAgent(1); await preview();
    const originalId = task!.id;
    transport.post.mockRejectedValueOnce(new ApiError({ kind: "network", code: "NETWORK_ERROR", status: 0, message: "ack lost" }));
    await confirm(1);
    await settle(() => expect(modal().textContent).toContain("导入提交的响应未确认"));
    const firstApply = transport.post.mock.calls[1]!;
    expect(firstApply).toEqual([`${base}/tasks/${originalId}/apply`, { idempotencyKey: expect.any(String) }]);
    expect(firstApply[1].idempotencyKey).not.toBe(transport.post.mock.calls[0]![1].idempotencyKey);
    expect(modal().querySelector('select[name="agent-import-user"]')).toBeNull();
    expect([...modal().querySelectorAll("button")].some((item) => item.textContent?.startsWith("确认导入"))).toBe(false);
    await poll(); await poll();
    expect(transport.post).toHaveBeenCalledTimes(2);
    await click(button("收起", modal()));
    await open();
    expect(modal().textContent).toContain(originalId);
    expect(modal().textContent).toContain("当前只读查询原任务");
    expect(transport.post).toHaveBeenCalledTimes(2);
    await click(button("使用原请求重试确认", modal()));
    const alert = document.querySelector('[role="alertdialog"]')!;
    expect(alert.textContent).toContain("原幂等键，不创建新任务");
    await click(button("重试原确认请求", alert));
    await settle(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    expect(transport.post.mock.calls[2]).toEqual(firstApply);
    await settle(() => expect(modal().textContent).toContain("已提交，等待后台导入"));
  });

  it("prevents duplicate preview and apply sends while their acknowledgments are pending", async () => {
    userRead = () => ({ users, nextCursor: "user-page-2" });
    await mount(); await open(); await chooseUser(); await chooseAgent(1);
    let finishPreview!: (value: { taskId: string }) => void;
    transport.post.mockImplementationOnce((_path: string, input: AgentImportPreview) => {
      task = createTask(input);
      return new Promise((resolve) => { finishPreview = resolve; });
    });
    const check = button("检查所选依赖", modal());
    await act(async () => { check.click(); check.click(); });
    await settle(() => expect(transport.post).toHaveBeenCalledTimes(1));
    expect(check.disabled).toBe(true);
    expect(modal().querySelector("fieldset")).toHaveProperty("disabled", true);
    const readsDuringPreview = userCalls().length;
    const picker = userSelect();
    expect(picker.matches(":disabled")).toBe(true);
    expect(button("加载更多用户", modal()).disabled).toBe(true);
    await click(picker); await click(button("加载更多用户", modal()));
    expect(picker.value).toBe(USER_A);
    expect(userCalls()).toHaveLength(readsDuringPreview);
    expect(candidateCalls().at(-1)![0]).toBe(`${base}/users/${USER_A}/agents`);
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).toBeNull();
    await act(async () => finishPreview({ taskId: task!.id }));
    await settle(() => expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).not.toBeNull());
    let finishApply!: (value: { taskId: string }) => void;
    transport.post.mockImplementationOnce(() => new Promise((resolve) => { finishApply = resolve; }));
    await click(button("确认导入 1 个 Agent", modal()));
    const start = button("开始后台导入", document.querySelector('[role="alertdialog"]')!);
    await act(async () => { start.click(); start.click(); });
    await settle(() => expect(transport.post).toHaveBeenCalledTimes(2));
    expect(start.disabled).toBe(true);
    expect(transport.post.mock.calls[1]![1]).toEqual({ idempotencyKey: expect.any(String) });
    task = { ...task!, status: "queued" };
    await act(async () => finishApply({ taskId: task!.id }));
    await settle(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    expect(transport.post).toHaveBeenCalledTimes(2);
  });

  it("reviews counts/conflicts and applies only a ready task without sending resource payloads", async () => {
    await mount(); await open(); await chooseUser(); await chooseAgent(1); await chooseAgent(2); await preview();
    task!.agents[1] = { ...task!.agents[1]!, status: "conflict", message: "同 ID 的依赖属于其他账号，不能覆盖" };
    task!.summary.conflicts = 1;
    await click(button("刷新任务状态", modal()));
    await settle(() => expect(modal().textContent).toContain("同 ID 的依赖属于其他账号，不能覆盖"));
    expect(modal().textContent).toContain("所选 Agent 2");
    expect(modal().textContent).toContain("可导入 1");
    expect(modal().textContent).toContain("冲突 1");
    expect(transport.post).toHaveBeenCalledTimes(1);
    await confirm(1);
    expect(transport.post.mock.calls[1]).toEqual([`${base}/tasks/${task!.id}/apply`, { idempotencyKey: expect.any(String) }]);
    expect(Object.keys(transport.post.mock.calls[0]![1]).sort()).toEqual(["agentIds", "idempotencyKey", "purpose", "sourceUserId"]);
    expect(transport.patch).not.toHaveBeenCalled();
    expect(transport.delete).not.toHaveBeenCalled();
  });

  it("cannot apply an expired plan or a plan with no ready roots", async () => {
    await mount(); await open(); await chooseUser(); await chooseAgent(1); await preview();
    task!.expiresAt = "2000-01-01T00:00:00.000Z";
    await click(button("刷新任务状态", modal()));
    await settle(() => expect(modal().textContent).toContain("检查已过期"));
    expect(button("确认导入 1 个 Agent", modal()).disabled).toBe(true);
    task!.expiresAt = "2099-01-01T00:00:00.000Z";
    task!.agents[0] = { ...task!.agents[0]!, status: "conflict", message: "目标已存在，不覆盖" };
    task!.summary.conflicts = 1;
    await click(button("刷新任务状态", modal()));
    await settle(() => expect(modal().textContent).toContain("目标已存在，不覆盖"));
    expect(button("确认导入 0 个 Agent", modal()).disabled).toBe(true);
    await click(button("确认导入 0 个 Agent", modal()));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it("uses the server's selection bound and does not turn a source read failure into an empty/successful list", async () => {
    maxAgents = 1;
    const view = await mount(); await open(); await chooseUser();
    expect(modal().querySelector('[role="checkbox"]')).toHaveProperty("disabled", true);
    await chooseAgent(1);
    expect(modal().textContent).toContain("已选 1 / 1");
    expect(modal().querySelector(`[role="checkbox"][aria-label="选择 Agent Agent 2（${uuid(2)}）"]`)).toHaveProperty("disabled", true);
    candidateRead = () => { throw new Error("授权来源暂时不可用"); };
    await select(userSelect(), USER_B);
    await settle(() => expect(modal().textContent).toContain("授权来源暂时不可用"));
    expect(modal().textContent).not.toContain("本页没有符合条件");
    expect(modal().textContent).not.toContain("全部已同步");
    expect(button("检查所选依赖", modal()).disabled).toBe(true);
    expect(view.container.textContent).toContain("Eval 原生配置");
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("polls active receipt recovery across close/reopen and adopts completion, refreshing Agent and public target-user resource caches", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    previewStatus = "checking";
    const view = await mount(); await open(); await chooseUser(); await chooseAgent(1); await preview();
    expect(modal().textContent).toContain("正在检查所选 Agent");
    expect([...modal().querySelectorAll("button")].some((item) => item.textContent?.startsWith("确认导入"))).toBe(false);
    task!.status = "ready";
    await poll();
    await settle(() => expect(button("确认导入 1 个 Agent", modal()).disabled).toBe(false));
    await confirm(1);
    task = { ...task!, status: "importing", progress: { stage: "references", completed: 1, total: 3, bytesRead: 400, totalBytes: 1024 } };
    await poll();
    await settle(() => expect(modal().textContent).toContain("导入参考资料"));
    expect(modal().querySelector('[role="progressbar"]')).not.toBeNull();
    expect(modal().textContent).toContain("已读取 400 B / 1.0 KB");
    expect(modal().querySelector('select[name="agent-import-user"]')).toBeNull();
    const readsBeforeClose = taskCalls().length;
    await click(modal().querySelector('[aria-label="关闭"]'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    task!.progress = { stage: "agents", completed: 2, total: 3, bytesRead: 1024, totalBytes: 1024 };
    await poll();
    expect(taskCalls().length).toBeGreaterThan(readsBeforeClose);
    await open();
    expect(modal().textContent).toContain("导入 Agent");
    expect(modal().textContent).toContain("当前只读查询原任务");
    expect(transport.post).toHaveBeenCalledTimes(2);
    task!.progress.stage = "receipts";
    task!.agents[0] = { ...task!.agents[0]!, status: "outcome_unknown" };
    task!.summary.failed = 1;
    await poll();
    await settle(() => expect(modal().textContent).toContain("后台核验回执与本地收尾中"));
    expect(modal().textContent).toContain("后台仍在自动恢复");
    expect(modal().textContent).not.toContain("不会自动重试");
    expect(modal().textContent).not.toContain("联系管理员核验");
    expect([...modal().querySelectorAll("button")].some((item) => /重新选择|确认导入|重试确认/u.test(item.textContent ?? ""))).toBe(false);
    await click(button("收起", modal()));
    const recoveryReads = taskCalls().length;
    await poll();
    expect(taskCalls().length).toBeGreaterThan(recoveryReads);
    await open();
    expect(modal().textContent).toContain("后台核验回执与本地收尾中");
    expect(transport.post).toHaveBeenCalledTimes(2);
    const resources = [
      skillQueryKeys.collection(TARGET, "library", ""),
      skillQueryKeys.selected(TARGET, [uuid(5)]),
      userReferenceQueryKeys.collection(TARGET, ""),
    ];
    const otherUser = skillQueryKeys.collection(USER_A, "library", "");
    for (const key of [...resources, otherUser]) view.query.setQueryData(key, "cached before import");
    const invalidate = vi.spyOn(view.query, "invalidateQueries");
    task!.agents[0] = { ...task!.agents[0]!, status: "created" };
    task!.summary.created = 1;
    task!.summary.failed = 0;
    await poll();
    await settle(() => expect(modal().textContent).toContain("已新增 1"));
    expect(modal().textContent).toContain("后台核验回执与本地收尾中");
    expect(modal().textContent).not.toContain("导入完成");
    expect(invalidate).not.toHaveBeenCalled();
    task!.status = "completed";
    task!.progress = { ...task!.progress, stage: "finished", completed: 3 };
    await poll();
    await settle(() => expect(modal().textContent).toContain("导入完成"));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agentKeys.all });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: skillQueryKeys.all(TARGET) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: userReferenceQueryKeys.collections(TARGET) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agentImportKeys.candidatesAll });
    expect(resources.every((key) => view.query.getQueryState(key)?.isInvalidated)).toBe(true);
    expect(view.query.getQueryState(otherUser)?.isInvalidated).toBe(false);
    const finalReads = taskCalls().length;
    await poll(); await poll();
    expect(taskCalls()).toHaveLength(finalReads);
    expect(transport.post).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector("tbody")?.textContent).toContain("Eval 原生配置");
    expect(view.container.textContent).not.toMatch(/eval_native|dev_import|INTERNAL_CONNECTION|alice@example/u);
  });

  it("refreshes a same-ID Reference when reopening editor details within the fresh cache window", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 22));
    const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 10_000 } } });
    let reference = {
      id: uuid(50), name: "Before.txt", mediaType: "text/plain", size: 4, status: "active",
      attachmentCdnUrl: "https://files.example.test/before.txt",
      createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z",
    };
    const editor = createAgentEditorClient(async <T,>(path: string) => {
      expect(path).toBe(`/api/user-references/${reference.id}`);
      return structuredClone(reference) as T;
    });
    const detail = {
      queryKey: userReferenceQueryKeys.detail(reference.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => editor.references.getReference(reference.id, signal),
    };
    await query.fetchQuery(detail);
    await mount(query); await open(); await chooseUser(); await chooseAgent(20); await preview(); await confirm(1);
    reference = {
      ...reference, name: "After.txt", attachmentCdnUrl: "https://files.example.test/after.txt",
      updatedAt: "2026-10-22T00:00:00.000Z",
    };
    task!.status = "completed";
    task!.agents[0] = { ...task!.agents[0]!, status: "overwritten" };
    task!.summary.overwritten = 1;
    task!.progress = { ...task!.progress, stage: "finished", completed: 3 };
    await poll();
    await settle(() => expect(modal().textContent).toContain("已覆盖 1"));
    const observer = new QueryObserver(query, detail);
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await settle(() => expect(observer.getCurrentResult().data).toMatchObject({
        id: uuid(50), name: "After.txt", attachmentCdnUrl: "https://files.example.test/after.txt",
      }));
    } finally {
      unsubscribe();
    }
  });

  it.each(["completed_with_errors", "failed", "outcome_unknown"] as const)("reports %s precisely instead of claiming everything is synced", async (status) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const view = await mount(); await open(); await chooseUser(); await chooseAgent(1); await chooseAgent(2); await preview();
    await confirm(2);
    task!.status = status;
    task!.summary = { created: 1, skipped: 0, failed: 1, conflicts: 0 };
    task!.agents[0] = { ...task!.agents[0]!, status: "created" };
    task!.agents[1] = { ...task!.agents[1]!, status: status === "outcome_unknown" ? "outcome_unknown" : "failed", message: "回执或依赖校验失败" };
    task!.error = status === "outcome_unknown" ? "公开回执缺失，待核验" : "依赖导入失败，成功部分保留";
    task!.progress.stage = status === "outcome_unknown" ? "receipts" : "finished";
    const invalidate = vi.spyOn(view.query, "invalidateQueries");
    await poll();
    await settle(() => expect(modal().textContent).toContain(task!.error));
    expect(modal().textContent).toContain("已新增 1");
    expect(modal().textContent).toContain("回执或依赖校验失败");
    expect(modal().textContent).not.toContain("导入完成");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agentKeys.all });
    expect(transport.post).toHaveBeenCalledTimes(2);
    if (status === "outcome_unknown") {
      expect(modal().textContent).toContain("部分写入可能已经生效");
      expect(modal().textContent).toContain("后台自动恢复已停止");
      expect(modal().textContent).not.toContain("后台仍在自动恢复");
      expect(modal().textContent).toContain("联系管理员核验");
      expect([...modal().querySelectorAll("button")].some((item) => /重新选择|确认导入|重试确认/u.test(item.textContent ?? ""))).toBe(false);
      const reads = taskCalls().length;
      await poll(); await poll();
      expect(taskCalls()).toHaveLength(reads);
      expect(transport.post).toHaveBeenCalledTimes(2);
    } else {
      expect(modal().textContent).toContain(status === "failed" ? "任务失败，导入未完成" : "部分导入未成功");
      expect(modal().textContent).toContain("资源会保留");
    }
  });

  it("restores after a full remount using only GET and the server's authoritative scope, roots and purpose", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = await mount(); await open(); await chooseUser(); await chooseAgent(1); await preview(); await confirm(1);
    const key = agentImportPointerKey(TARGET);
    expect(key).toContain(encodeURIComponent(window.location.origin));
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ taskId: task!.id });
    await leave(first);
    task = {
      ...task!, sourceUserId: USER_B, purpose: "evaluation", status: "importing",
      agents: [{ id: uuid(41), name: "服务器权威 Agent", status: "outcome_unknown", skillCount: 4, referenceCount: 3 }],
      progress: { ...task!.progress, stage: "receipts" }, summary: { created: 0, skipped: 0, failed: 1, conflicts: 0 },
    };
    transport.post.mockClear(); transport.get.mockClear();
    const second = await reopenPersisted();
    expect(modal().textContent).toContain("本次 dev 用户：未命名用户");
    expect(modal().textContent).not.toContain(USER_B);
    expect(modal().textContent).toContain("用途：评估 Agent");
    expect(modal().textContent).toContain("服务器权威 Agent");
    expect(modal().textContent).toContain(uuid(41));
    expect(modal().textContent).toContain("后台仍在自动恢复");
    expect(modal().textContent).not.toContain("后台自动恢复已停止");
    expect(modal().querySelector('select[name="agent-import-user"]')).toBeNull();
    expect(candidateCalls()).toHaveLength(0);
    expect(transport.get.mock.calls.some(([path]) => path === `${base}/users`)).toBe(false);
    expect(taskCalls()).toHaveLength(1);
    task!.progress = { stage: "receipts", completed: 2, total: 3, bytesRead: 600, totalBytes: 1024 };
    await poll();
    await settle(() => expect(modal().textContent).toContain("已读取 600 B"));
    expect(transport.post).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ taskId: task!.id });
    expect(second.container.textContent).not.toMatch(/eval_native|dev_import|INTERNAL_CONNECTION|服务器权威 Agent/u);
    task!.status = "completed";
    task!.agents[0] = { ...task!.agents[0]!, status: "created" };
    task!.summary = { created: 1, skipped: 0, failed: 0, conflicts: 0 };
    task!.progress.stage = "finished";
    await poll();
    await settle(() => expect(modal().textContent).toContain("导入完成"));
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("does not use a previous target user's pointer or cached identity while verifying the current user", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 22));
    persistedTask();
    const oldPointer = window.localStorage.getItem(agentImportPointerKey(TARGET));
    targetUserId = uuid(901);
    const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 10_000 } } });
    query.setQueryData(meKey, { id: TARGET, role: "user" });
    const original = transport.get.getMockImplementation()!;
    let verify!: (value: unknown) => void;
    transport.get.mockImplementation((path: string, options?: unknown) => path === "/api/me"
      ? new Promise((resolve) => { verify = resolve; }) : original(path, options));
    await mount(query);
    await click(button("从 dev 导入"));
    await settle(() => expect(transport.get.mock.calls.filter(([path]) => path === "/api/me")).toHaveLength(1));
    expect(modal().textContent).toContain("正在确认 Eval 账号并只读恢复任务定位信息");
    expect(modal().querySelector('[aria-label="选择 dev 用户"]')).toBeNull();
    expect(userCalls()).toHaveLength(0);
    expect(taskCalls()).toHaveLength(0);
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).toBeNull();
    await act(async () => verify({ id: targetUserId, role: "user" }));
    await settle(() => expect(modal().textContent).toContain("Dev Alice"));
    expect(userCalls()).toHaveLength(1);
    expect(taskCalls()).toHaveLength(0);
    expect(window.localStorage.getItem(agentImportPointerKey(TARGET))).toBe(oldPointer);
    expect(window.localStorage.getItem(agentImportPointerKey(targetUserId))).toBeNull();
    expect(transport.post).not.toHaveBeenCalled();
  });

  it.each([
    "{", JSON.stringify({ taskId: "../not-a-task" }),
    JSON.stringify({ taskId: uuid(1001), sourceUserId: USER_B, status: "completed" }),
  ])("cleans a malformed pointer without fetching it or changing the ordinary list: %s", async (raw) => {
    window.localStorage.setItem(agentImportPointerKey(TARGET), raw);
    const view = await mount(); await open();
    expect(modal().textContent).toContain("任务定位信息已损坏，已清理");
    expect(window.localStorage.getItem(agentImportPointerKey(TARGET))).toBeNull();
    expect(taskCalls()).toHaveLength(0);
    expect(transport.post).not.toHaveBeenCalled();
    expect(view.container.querySelector("tbody")?.textContent).toContain("Eval 原生配置");
  });

  it("degrades to the current-page workflow when storage read/write is blocked", async () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "QuotaExceededError"); });
    await mount(); await open();
    expect(modal().textContent).toContain("浏览器无法保存或清理任务定位信息");
    await chooseUser(); await chooseAgent(1); await preview();
    expect(modal().textContent).toContain("请保留任务 ID");
    await confirm(1);
    expect(transport.post).toHaveBeenCalledTimes(2);
    await click(button("收起", modal())); await open();
    expect(modal().textContent).toContain(task!.id);
    expect(transport.post).toHaveBeenCalledTimes(2);
    read.mockRestore(); write.mockRestore();
    expect(window.localStorage.getItem(agentImportPointerKey(TARGET))).toBeNull();
  });

  it("ignores a broken pointer safely even if browser storage also rejects cleanup", async () => {
    window.localStorage.setItem(agentImportPointerKey(TARGET), "{");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    await mount(); await open();
    expect(modal().textContent).toContain("浏览器无法保存或清理");
    expect(taskCalls()).toHaveLength(0);
    expect(transport.post).not.toHaveBeenCalled();
  });

  it.each([404, 403, "invalid-response"] as const)("invalidates an inaccessible or invalid task pointer safely (%s)", async (failure) => {
    const stored = persistedTask();
    const original = transport.get.getMockImplementation()!;
    transport.get.mockImplementation((path: string, options?: unknown) => {
      if (path === `${base}/tasks/${stored.id}`) {
        if (failure === "invalid-response") return { ...stored, id: uuid(9999) };
        throw new ApiError({ kind: "http", status: failure, code: "AGENT_IMPORT_TASK_NOT_FOUND", message: "not visible to current owner" });
      }
      return original(path, options);
    });
    await mount(); await click(button("从 dev 导入"));
    await settle(() => expect(modal().textContent).toContain("已清理定位指针"));
    await settle(() => expect(modal().textContent).toContain("Dev Alice"));
    expect(userCalls()).toHaveLength(1);
    expect(window.localStorage.getItem(agentImportPointerKey(TARGET))).toBeNull();
    expect(taskCalls()).toHaveLength(1);
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).toBeNull();
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("retains a pointer on a transient task read failure and retries only the original GET", async () => {
    const stored = persistedTask();
    const original = transport.get.getMockImplementation()!;
    let unavailable = true;
    transport.get.mockImplementation((path: string, options?: unknown) => {
      if (path === `${base}/tasks/${stored.id}` && unavailable) throw new ApiError({
        kind: "http", status: 503, code: "DATABASE_UNAVAILABLE", message: "fixture outage",
      });
      return original(path, options);
    });
    await mount(); await click(button("从 dev 导入"));
    await settle(() => expect(modal().textContent).toContain("数据库暂时不可用"));
    expect(window.localStorage.getItem(agentImportPointerKey(TARGET))).not.toBeNull();
    expect(modal().querySelector('select[name="agent-import-user"]')).toBeNull();
    unavailable = false;
    await click(button("刷新任务状态", modal()));
    await settle(() => expect(modal().textContent).toContain("已从服务端恢复原任务"));
    expect(taskCalls()).toHaveLength(2);
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("clears an already-restored pointer if a later task read becomes inaccessible, without inferring the old import's outcome", async () => {
    const stored = persistedTask();
    await reopenPersisted();
    const original = transport.get.getMockImplementation()!;
    transport.get.mockImplementation((path: string, options?: unknown) => {
      if (path === `${base}/tasks/${stored.id}`) throw new ApiError({
        kind: "http", status: 404, code: "AGENT_IMPORT_TASK_NOT_FOUND", message: "task no longer visible",
      });
      return original(path, options);
    });
    await click(button("刷新任务状态", modal()));
    await settle(() => expect(modal().textContent).toContain("原任务结果请联系管理员核验"));
    expect(window.localStorage.getItem(agentImportPointerKey(TARGET))).toBeNull();
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).toBeNull();
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("recovers on route re-entry with the existing query cache without replaying any POST", async () => {
    const view = await mount(); await open(); await chooseUser(); await chooseAgent(1); await preview(); await confirm(1);
    const id = task!.id;
    await act(async () => { await view.router.navigate({ to: "/agents/new" }); });
    await settle(() => expect(view.container.textContent).toContain("Agent 创建页"));
    task!.status = "importing";
    transport.post.mockClear(); transport.get.mockClear();
    await act(async () => { await view.router.navigate({ to: "/agents" }); });
    await settle(() => expect(view.container.textContent).toContain("Eval 原生配置"));
    await click(button("从 dev 导入"));
    await settle(() => expect(modal().textContent).toContain("已从服务端恢复原任务"));
    expect(modal().textContent).toContain(id);
    expect(modal().textContent).toContain("后台导入中");
    expect(taskCalls()).toHaveLength(1);
    expect(candidateCalls()).toHaveLength(0);
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("can read an existing task after the optional dev source has been disabled", async () => {
    persistedTask();
    enabled = false;
    await reopenPersisted();
    expect(modal().textContent).toContain("当前环境已停用 dev 导入");
    expect(modal().textContent).toContain("后台导入中");
    expect(taskCalls()).toHaveLength(1);
    expect(candidateCalls()).toHaveLength(0);
    expect(transport.get.mock.calls.some(([path]) => path === `${base}/users`)).toBe(false);
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("does not treat fresh cached terminal task scope as authoritative before a recovery GET completes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 22));
    const stored = structuredClone(persistedTask());
    const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 10_000 } } });
    query.setQueryData(agentImportKeys.task(TARGET, stored.id), {
      ...stored, sourceUserId: USER_B, status: "completed",
      agents: [{ ...stored.agents[0], id: uuid(41), name: "不可信的旧缓存名称" }],
    });
    const original = transport.get.getMockImplementation()!;
    let finish!: (value: AgentImportTaskView) => void;
    transport.get.mockImplementation((path: string, options?: unknown) => path === `${base}/tasks/${stored.id}`
      ? new Promise((resolve) => { finish = resolve; }) : original(path, options));
    await mount(query); await click(button("从 dev 导入"));
    await settle(() => expect(taskCalls()).toHaveLength(1));
    expect(modal().textContent).toContain("正在确认 Eval 账号并只读恢复任务定位信息");
    expect(modal().textContent).not.toContain("已从服务端恢复原任务");
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).toBeNull();
    expect(modal().textContent).not.toContain("不可信的旧缓存名称");
    expect(transport.post).not.toHaveBeenCalled();
    await act(async () => finish(stored));
    await settle(() => expect(modal().textContent).toContain("已从服务端恢复原任务"));
    expect(modal().textContent).toContain("本次 dev 用户：未命名用户");
    expect(modal().textContent).not.toContain(USER_A);
    expect(modal().textContent).toContain(uuid(1));
    expect(modal().textContent).toContain("后台导入中");
    expect(modal().textContent).not.toContain("不可信的旧缓存名称");
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("aborts a recovery read when the verified target changes and cannot bind its late response to the new user", async () => {
    const stored = structuredClone(persistedTask());
    const original = transport.get.getMockImplementation()!;
    let finish!: (value: AgentImportTaskView) => void;
    let signal!: AbortSignal;
    transport.get.mockImplementation((path: string, options?: { signal?: AbortSignal }) => {
      if (path === `${base}/tasks/${stored.id}`) {
        signal = options!.signal!;
        return new Promise((resolve) => { finish = resolve; });
      }
      return original(path, options);
    });
    const view = await mount(); await click(button("从 dev 导入"));
    await settle(() => expect(taskCalls()).toHaveLength(1));
    targetUserId = uuid(901);
    await act(async () => { await view.query.invalidateQueries({ queryKey: meKey }); });
    await settle(() => expect(modal().textContent).toContain("Dev Alice"));
    expect(userCalls()).toHaveLength(1);
    expect(signal.aborted).toBe(true);
    await act(async () => finish(stored));
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).toBeNull();
    expect(modal().textContent).not.toContain(stored.id);
    expect(window.localStorage.getItem(agentImportPointerKey(TARGET))).not.toBeNull();
    expect(window.localStorage.getItem(agentImportPointerKey(targetUserId))).toBeNull();
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("restores an unsubmitted preview read-only and clears it only when the user explicitly starts a new selection", async () => {
    const stored = persistedTask("ready");
    await reopenPersisted();
    expect(modal().textContent).toContain("已恢复检查结果（只读）");
    expect([...modal().querySelectorAll("button")].some((item) => item.textContent?.startsWith("确认导入"))).toBe(false);
    expect(transport.post).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(agentImportPointerKey(TARGET))).toContain(stored.id);
    await click(button("重新选择", modal()));
    await settle(() => expect(modal().textContent).toContain("Dev Alice"));
    expect(window.localStorage.getItem(agentImportPointerKey(TARGET))).toBeNull();
    expect(modal().querySelector('[aria-label="逐 Agent 导入结果"]')).toBeNull();
    expect(modal().textContent).toContain("Dev Bob");
    await chooseUser(USER_B); await chooseAgent(41); await preview();
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post.mock.calls[0]![1]).toMatchObject({ sourceUserId: USER_B, agentIds: [uuid(41)] });
    expect(task!.id).not.toBe(stored.id);
    expect(JSON.parse(window.localStorage.getItem(agentImportPointerKey(TARGET))!)).toEqual({ taskId: task!.id });
  });

  it.each([
    ["completed", "created"], ["completed_with_errors", "failed"], ["failed", "failed"],
    ["outcome_unknown", "outcome_unknown"], ["outcome_unknown", "created"],
  ] as const)("restores terminal %s with %s Agent rows without automatic replay or polling", async (status, agentStatus) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stored = persistedTask(status);
    stored.agents[0] = { ...stored.agents[0]!, status: agentStatus };
    stored.summary.created = agentStatus === "created" ? 1 : 0;
    stored.summary.failed = agentStatus === "created" ? 0 : 1;
    stored.progress.stage = status === "outcome_unknown" ? "receipts" : "finished";
    await reopenPersisted();
    expect(modal().textContent).toContain(stored.id);
    expect(modal().textContent).toContain("只读查看范围与结果");
    expect(JSON.parse(window.localStorage.getItem(agentImportPointerKey(TARGET))!)).toEqual({ taskId: stored.id });
    expect(transport.post).not.toHaveBeenCalled();
    const reads = taskCalls().length;
    await poll(); await poll();
    expect(taskCalls()).toHaveLength(reads);
    expect(transport.post).not.toHaveBeenCalled();
    if (status === "outcome_unknown") {
      expect(modal().textContent).toContain("后台自动恢复已停止");
      expect(modal().textContent).not.toContain("后台仍在自动恢复");
      expect(modal().textContent).toContain("联系管理员核验");
      expect([...modal().querySelectorAll("button")].some((item) => /重新选择|确认导入|重试确认/u.test(item.textContent ?? ""))).toBe(false);
      expect(modal().querySelector('select[name="agent-import-user"]')).toBeNull();
      stored.status = "completed";
      stored.agents[0] = { ...stored.agents[0]!, status: "created" };
      stored.summary = { created: 1, skipped: 0, failed: 0, conflicts: 0 };
      stored.progress.stage = "finished";
      await poll();
      expect(taskCalls()).toHaveLength(reads);
      expect(modal().textContent).toContain("导入结果待核验");
      await click(button("刷新任务状态", modal()));
      await settle(() => expect(modal().textContent).toContain("导入完成"));
      expect(taskCalls()).toHaveLength(reads + 1);
      expect(transport.post).not.toHaveBeenCalled();
    } else {
      await click(button("重新选择", modal()));
      expect(window.localStorage.getItem(agentImportPointerKey(TARGET))).toBeNull();
      expect(transport.post).not.toHaveBeenCalled();
    }
  });
});
