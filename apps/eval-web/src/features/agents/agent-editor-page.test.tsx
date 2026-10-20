import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDraft } from "@springbrand/agent-config-editor";
import type { CreateUserAgentConfigInput, UserAgentConfigTemplate } from "@springbrand/agent-config-editor/client";
import { agentKeys } from "@/api-sdk/agent-configs-api";
import { agentLibraryKeys } from "@/api-sdk/agent-editor-api";
import { ApiError } from "@/api-sdk/client";
import type { AgentConfig } from "@/api-sdk/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { click, render, select, type } from "@/test/render";
import { AgentEditorPage } from "./agent-editor-page";

const transport = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), request: vi.fn() }));
vi.mock("@/api-sdk/client", async (original) => ({ ...await original<object>(), api: transport }));

const setting: AgentDraft["setting"] = {
  presetId: null, model: null, thinking: "medium", systemPrompt: "Template instructions",
  toolPolicy: { allow: [], deny: ["dangerous_tool"] }, subagentNames: ["researcher"], executionLevel: "safe",
  memoryDefaults: { enabled: false, memoryTokens: 3_000, preferencesTokens: 750 }, sandbox: { enabled: true },
  skillIds: [], mcpServers: [{ serverId: "platform-mcp" }], actionIds: [], connectorIds: [], extensionIds: [], referenceFileIds: [],
};
const modelCatalog = [
  {
    id: "deepseek-flash-balanced", name: "DeepSeek V4.1 Flash", providerModel: "deepseek/deepseek-v4.1-flash",
    thinking: "high", executionLevel: "high", default: true, requiredPlan: "free", available: true,
    thinkingLevels: ["none", "low", "high", "max"],
  },
  {
    id: "gemini-flash-fast", name: "Claude Sonnet 5.5", providerModel: "anthropic/claude-sonnet-5.5",
    thinking: "medium", executionLevel: "high", requiredPlan: "free", available: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-opus-max", name: "Claude Opus 5.5", providerModel: "anthropic/claude-opus-5.5",
    thinking: "high", executionLevel: "high", requiredPlan: "pro", available: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  },
];
const template: UserAgentConfigTemplate = { name: "新建 Agent", description: null, setting: { ...setting, mcpServers: [] } };
const initial: AgentConfig = {
  id: "agent-a", user_id: "user-a", slug: "agent-a", name: "Original name", description: null,
  revision: 3, setting_schema_version: 4, setting, is_default: false, created_at: 1, updated_at: 1,
};
let stored: AgentConfig;

function button(label: string, within: ParentNode = document) {
  const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function name() { return document.querySelector<HTMLInputElement>("#agent-name"); }
async function settle(check: () => void) { await act(async () => { await vi.waitFor(check); }); }

async function mount(path = "/agents/new") {
  const root = createRootRoute({ component: Outlet });
  const list = createRoute({ getParentRoute: () => root, path: "/agents", component: () => <p>Agent directory</p> });
  const create = createRoute({ getParentRoute: () => root, path: "/agents/new", component: () => <AgentEditorPage /> });
  const edit = createRoute({ getParentRoute: () => root, path: "/agents/$id", component: () => <AgentEditorPage id="agent-a" /> });
  const router = createRouter({ routeTree: root.addChildren([list, create, edit]), history: createMemoryHistory({ initialEntries: [path] }) });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={query}><RouterProvider router={router} /></QueryClientProvider></TooltipProvider>);
  return { ...view, query, router, close: async () => { await view.unmount(); query.clear(); } };
}

describe("SP Agent editor in Eval", () => {
  beforeEach(() => {
    for (const mock of Object.values(transport)) mock.mockReset();
    stored = structuredClone(initial);
    transport.get.mockImplementation(async (path: string) => {
      if (path === "/api/me") return { id: "user-a", role: "user" };
      if (path === "/api/agent-library/default-template") return structuredClone(template);
      if (path === "/api/agent-configs/agent-a") return structuredClone(stored);
      if (path === "/api/agents") return [{ name: "Original name", agentConfig: { userAgentId: "agent-a" }, role: "evaluator", purpose: "evaluation" }];
      if (path === "/api/agent-library/user-agent-configs/agent-a/deletion-check") return {
        allowed: true, activeChatIds: [], enabledScheduleIds: [], unfinishedRunIds: [],
      };
      if (path === "/api/agent-library/mcp-servers?source=user&page=1&pageSize=100") return {
        data: [{
          id: "platform-mcp", name: "Eval 结果提交", description: "submit_evaluation", status: "active", source: "user",
          url: "https://evalapi.example/mcp/evaluation-results", authType: "bearer",
        }], total: 1, page: 1, pageSize: 100,
      };
      if (path === "/api/agent-library/mcp-servers/platform-mcp") return {
        id: "platform-mcp", name: "Eval 结果提交", description: "submit_evaluation", status: "active", source: "user",
        url: "https://evalapi.example/mcp/evaluation-results", authType: "bearer",
      };
      throw new Error(`Unexpected GET ${path}`);
    });
    transport.request.mockImplementation(async (path: string) => {
      const url = new URL(path, "http://eval.test");
      if (url.pathname === "/api/agent-library/models") return modelCatalog;
      if (url.pathname === "/api/agent-library/connectors") return { items: [], nextCursor: null };
      if (url.pathname === "/api/agent-library/components") return { data: [], page: 1, pageSize: 50, total: 0 };
      if (url.pathname === "/api/agent-library/skills") return {
        data: [{ id: "skill-a", name: "Research Skill", description: "Research", origin: "upload", available: true, deleted: false }],
        page: 1, pageSize: 50, total: 1,
      };
      throw new Error(`Unexpected library request ${path}`);
    });
    transport.post.mockImplementation(async (_path: string, input: CreateUserAgentConfigInput) => {
      stored = { ...stored, ...input, revision: 1 };
      return structuredClone(stored);
    });
    transport.patch.mockImplementation(async (_path: string, input: object) => {
      stored = { ...stored, ...input, revision: stored.revision + 1 };
      return structuredClone(stored);
    });
    window.scrollTo = vi.fn();
  });

  it("shows selected MCP Servers read-only and keeps them on save", async () => {
    const view = await mount("/agents/agent-a");
    try {
      await settle(() => expect(view.container.textContent).toContain("MCP Server (1)"));
      await settle(() => expect(view.container.textContent).toContain("Eval 结果提交"));
      expect(view.container.textContent).toContain("https://evalapi.example/mcp/evaluation-results");
      const mcp = view.container.querySelector('fieldset [aria-label="MCP Server"]');
      expect(mcp).not.toBeNull();
      expect(mcp!.compareDocumentPosition(button("保存修改")) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      expect(view.container.textContent).not.toContain("工具服务");
      await type(name(), "Renamed");
      await click(button("保存修改"));
      await settle(() => expect(transport.patch).toHaveBeenCalledTimes(1));
      expect(transport.patch.mock.calls[0]![1]).toMatchObject({ setting: { mcpServers: [{ serverId: "platform-mcp" }] } });
    } finally {
      await view.close();
    }
  });

  it("creates with the SP template, prompt dialog, resource selector and validated settings", async () => {
    const view = await mount();
    try {
      await settle(() => expect(name()).not.toBeNull());
      expect(view.container.textContent).not.toContain("Slug");
      expect(view.container.querySelector('[aria-label="基本信息"] #agent-name')).not.toBeNull();
      expect(view.container.querySelector('[data-agent-prompt] textarea')).not.toBeNull();
      expect(view.container.querySelector('[data-agent-runtime] #agent-model')).not.toBeNull();
      expect(view.container.textContent).not.toContain("行为与指令");
      expect(view.container.querySelector('[data-agent-runtime] [aria-expanded]')).toBeNull();
      expect(view.container.textContent).not.toContain("暂未添加");
      expect(view.container.querySelectorAll('[data-agent-empty]')).toHaveLength(6);
      expect(view.container.querySelector('[data-agent-empty] [aria-expanded]')).toBeNull();
      expect(view.container.querySelector('[aria-label="添加任务技能"]')).not.toBeNull();
      for (const label of ["Behavior", "Thinking", "Connectors", "Save changes", "None selected."]) expect(view.container.textContent).not.toContain(label);
      const thinking = view.container.querySelector<HTMLSelectElement>('#agent-thinking')!;
      await settle(() => expect(thinking.options.length).toBeGreaterThan(0));
      expect([...thinking.options].map((option) => option.textContent)).toEqual(['不额外思考', '较浅', '深入', '极高']);
      expect([...thinking.options].map((option) => option.value)).toEqual(['none', 'low', 'high', 'max']);
      expect(view.container.querySelector('#agent-model option[value=""]')).toBeNull();
      expect(view.container.textContent).toContain("DeepSeek V4.1 Flash");
      expect(view.container.textContent).toContain("Claude Sonnet 5.5");
      expect(view.container.textContent).not.toContain("setting JSON");
      for (const section of ["模型", "思考深度", "外部应用连接", "内置连接工具", "扩展能力", "可执行操作", "任务技能", "参考资料"]) {
        expect(view.container.textContent).toContain(section);
      }
      await type(name(), "  Research Agent  ");
      await type(document.querySelector("#agent-description"), "Research description");
      await type(document.querySelector('[aria-label="完整工作指令"]'), "Updated instructions");
      await select(document.querySelector("#agent-model"), "gemini-flash-fast");
      const sonnetThinking = document.querySelector<HTMLSelectElement>("#agent-thinking")!;
      expect([...sonnetThinking.options].map((option) => option.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
      await select(sonnetThinking, "xhigh");
      await click(document.querySelector('[aria-label="添加任务技能"]'));
      await settle(() => expect(document.querySelector('[aria-label="选择Research Skill"]')).not.toBeNull());
      await click(document.querySelector('[aria-label="选择Research Skill"]'));
      await click(button("保存修改", document.querySelector('[role="dialog"]')!));
      await click(button("创建 Agent"));
      await settle(() => expect(transport.post).toHaveBeenCalledTimes(1));
      expect(transport.post.mock.calls[0]).toEqual(["/api/agent-configs", {
        slug: expect.stringMatching(/^agent-[\da-f-]{36}$/u), name: "Research Agent", description: "Research description", purpose: "execution",
        setting: {
          ...template.setting,
          presetId: "gemini-flash-fast",
          model: "anthropic/claude-sonnet-5.5",
          thinking: "xhigh",
          executionLevel: "high",
          systemPrompt: "Updated instructions",
          skillIds: ["skill-a"],
        },
      }]);
      await settle(() => expect(view.router.state.location.pathname).toBe("/agents/agent-a"));
      expect(transport.request.mock.calls.some(([path]) => path.startsWith("/api/agent-library/skills?") && path.includes("view=selectable"))).toBe(true);
    } finally { await view.close(); }
  });

  it("adds the result MCP when a new Agent is marked for evaluation", async () => {
    const view = await mount();
    try {
      await settle(() => expect(name()).not.toBeNull());
      const evaluationPurpose = view.container.querySelector<HTMLInputElement>('input[name="agent-purpose"][value="evaluation"]');
      await settle(() => expect(evaluationPurpose?.disabled).toBe(false));
      await click(evaluationPurpose);
      await settle(() => expect(view.container.textContent).toContain("已自动连接：Eval 结果提交"));
      await type(name(), "Evaluator");
      await click(button("创建 Agent"));
      await settle(() => expect(transport.post).toHaveBeenCalledTimes(1));
      expect(transport.post.mock.calls[0]![1]).toMatchObject({ setting: { mcpServers: [{ serverId: "platform-mcp" }] } });
    } finally { await view.close(); }
  });

  it("waits for refreshed purpose options after creation without retaining an unavailable error", async () => {
    const get = transport.get.getMockImplementation()!;
    let resolveOptions!: (value: unknown) => void;
    const options = new Promise((resolve) => { resolveOptions = resolve; });
    transport.get.mockImplementation(async (path: string) => path === "/api/agents" ? options : get(path));
    const view = await mount();
    try {
      await settle(() => expect(name()).not.toBeNull());
      view.query.setQueryData(agentKeys.options(), []);
      await type(name(), "Created Agent");
      await click(button("创建 Agent"));
      await settle(() => expect(view.router.state.location.pathname).toBe("/agents/agent-a"));
      await settle(() => expect(name()?.value).toBe("Created Agent"));

      expect(view.container.textContent).not.toContain("Agent 用途暂时不可用");
      await act(async () => {
        resolveOptions([{
          name: "Created Agent", role: "executor", purpose: "execution", agentConfig: { userAgentId: "agent-a" },
        }]);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await settle(() => expect(view.container.querySelector<HTMLInputElement>('input[name="agent-purpose"][value="execution"]')?.checked).toBe(true));
      expect(view.container.textContent).not.toContain("Agent 用途暂时不可用");
      await type(name(), "Edited after creation");
      await click(button("保存修改"));
      await settle(() => expect(transport.patch).toHaveBeenCalledTimes(1));
      expect(transport.patch.mock.calls[0]![1]).toMatchObject({ name: "Edited after creation", purpose: "execution" });
      expect(transport.post).toHaveBeenCalledTimes(1);
    } finally { await view.close(); }
  });

  it.each(["unavailable", "missing"] as const)("keeps a genuine %s purpose error until its query recovers without losing the draft", async (failure) => {
    const get = transport.get.getMockImplementation()!;
    transport.get.mockImplementation(async (path: string) => {
      if (path !== "/api/agents") return get(path);
      if (failure === "missing") return [];
      throw new ApiError({ kind: "http", status: 503, code: "AGENT_CONFIG_PURPOSE_UNAVAILABLE", message: "Catalog unavailable" });
    });
    const view = await mount("/agents/agent-a");
    try {
      await settle(() => expect(view.container.textContent).toContain("Agent 用途暂时不可用"));
      await type(name(), "Keep this draft");
      expect(view.container.textContent).toContain("Agent 用途暂时不可用");

      transport.get.mockImplementation(get);
      await act(async () => {
        await view.query.invalidateQueries({ queryKey: agentKeys.options() });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await settle(() => expect(view.container.querySelector<HTMLInputElement>('input[name="agent-purpose"][value="evaluation"]')?.checked).toBe(true));
      expect(view.container.textContent).not.toContain("Agent 用途暂时不可用");
      expect(name()?.value).toBe("Keep this draft");
      expect(transport.post).not.toHaveBeenCalled();
      expect(transport.patch).not.toHaveBeenCalled();
    } finally { await view.close(); }
  });

  it("keeps the purpose selector available while the result MCP is loading", async () => {
    const get = transport.get.getMockImplementation()!;
    transport.get.mockImplementation(async (path: string) => {
      if (path === "/api/agent-library/mcp-servers?source=user&page=1&pageSize=100") return new Promise(() => {});
      return get(path);
    });
    const view = await mount();
    try {
      await settle(() => expect(name()).not.toBeNull());
      expect(view.container.querySelector<HTMLInputElement>('input[name="agent-purpose"][value="evaluation"]')?.disabled).toBe(false);
    } finally { await view.close(); }
  });

  it("allows an existing Agent to switch purpose and removes the result MCP when returning to execution", async () => {
    const view = await mount("/agents/agent-a");
    try {
      await settle(() => expect(view.container.querySelector("[data-agent-purpose]")).not.toBeNull());
      await settle(() => expect(view.container.querySelector<HTMLInputElement>('input[name="agent-purpose"][value="evaluation"]')?.checked).toBe(true));
      const executionPurpose = view.container.querySelector<HTMLInputElement>('input[name="agent-purpose"][value="execution"]')!;
      await click(executionPurpose);
      await settle(() => expect(view.container.querySelector<HTMLInputElement>('input[name="agent-purpose"][value="execution"]')?.checked).toBe(true));
      await act(async () => { await view.query.invalidateQueries({ queryKey: agentKeys.options() }); });
      await settle(() => expect(view.container.querySelector<HTMLInputElement>('input[name="agent-purpose"][value="execution"]')?.checked).toBe(true));
      await click(button("保存修改"));
      await settle(() => expect(transport.patch).toHaveBeenCalledTimes(1));
      expect(transport.patch.mock.calls[0]![1]).toMatchObject({
        purpose: "execution", setting: { mcpServers: [] },
      });
    } finally { await view.close(); }
  });

  it("cancels creation without writing a config", async () => {
    const view = await mount();
    try {
      await settle(() => expect(name()).not.toBeNull());
      await type(name(), "Discard me");
      await click(button("取消"));
      await settle(() => expect(view.router.state.location.pathname).toBe("/agents"));
      expect(transport.post).not.toHaveBeenCalled();
      expect(transport.patch).not.toHaveBeenCalled();
    } finally { await view.close(); }
  });

  it("waits for the real SP template and retries an initial failure without an empty-settings fallback", async () => {
    const get = transport.get.getMockImplementation()!;
    transport.get.mockImplementation(async (path: string) => {
      if (path === "/api/agent-library/default-template") throw new Error("Template unavailable");
      return get(path);
    });
    const view = await mount();
    try {
      await settle(() => expect(view.container.textContent).toContain("Template unavailable"));
      expect(name()).toBeNull();
      expect(transport.post).not.toHaveBeenCalled();
      transport.get.mockImplementation(get);
      await click(button("重试"));
      await settle(() => expect(name()).not.toBeNull());
      expect(view.container.textContent).toContain("Template instructions");
    } finally { await view.close(); }
  });

  it("keeps the draft and creation slug through an unknown write and a failed background template refresh", async () => {
    transport.post.mockRejectedValueOnce(new ApiError({ kind: "network", code: "NETWORK_ERROR", status: 0, message: "ack lost" }));
    const view = await mount();
    try {
      await settle(() => expect(name()).not.toBeNull());
      await type(name(), "Keep my draft");
      await click(button("创建 Agent"));
      await settle(() => expect(transport.post).toHaveBeenCalledTimes(1));
      const request = transport.post.mock.calls[0]![1];
      transport.get.mockImplementationOnce(async () => { throw new Error("Template temporarily unavailable"); });
      await act(async () => { await view.query.invalidateQueries({ queryKey: agentLibraryKeys.template }); });
      await settle(() => expect(view.container.textContent).toContain("Template temporarily unavailable"));
      expect(name()?.value).toBe("Keep my draft");
      await click(button("重试"));
      await settle(() => expect(view.container.textContent).not.toContain("Template temporarily unavailable"));
      expect(name()?.value).toBe("Keep my draft");
      await click(button("创建 Agent"));
      await settle(() => expect(transport.post).toHaveBeenCalledTimes(2));
      expect(transport.post.mock.calls[1]![1]).toEqual(request);
    } finally { await view.close(); }
  });

  it("retains edit drafts across background read failures, preserves hidden settings and uses the actual revision", async () => {
    const view = await mount("/agents/agent-a");
    try {
      await settle(() => expect(name()?.value).toBe("Original name"));
      await type(name(), "Unsaved name");
      transport.get.mockRejectedValueOnce(new Error("Config temporarily unavailable"));
      await act(async () => { await view.query.invalidateQueries({ queryKey: agentKeys.detail("agent-a") }); });
      await settle(() => expect(view.container.textContent).toContain("Config temporarily unavailable"));
      expect(name()?.value).toBe("Unsaved name");
      await click(button("重试"));
      await settle(() => expect(view.container.textContent).not.toContain("Config temporarily unavailable"));
      expect(name()?.value).toBe("Unsaved name");
      await click(button("保存修改"));
      await settle(() => expect(transport.patch).toHaveBeenCalledExactlyOnceWith("/api/agent-configs/agent-a", {
        revision: 3, name: "Unsaved name", description: null, setting, purpose: "evaluation",
      }));
    } finally { await view.close(); }
  });

  it("retains the draft after a revision conflict", async () => {
    transport.patch.mockRejectedValueOnce(new ApiError({ kind: "http", code: "AGENT_CONFIG_REVISION_CONFLICT", status: 409, message: "Conflict" }));
    const view = await mount("/agents/agent-a");
    try {
      await settle(() => expect(name()?.value).toBe("Original name"));
      await type(name(), "My version");
      await click(button("保存修改"));
      await settle(() => expect(view.container.textContent).toContain("你的修改仍然保留"));
      await act(async () => { await view.query.invalidateQueries({ queryKey: agentKeys.options() }); });
      expect(view.container.textContent).toContain("你的修改仍然保留");
      expect(name()?.value).toBe("My version");
      expect(transport.patch).toHaveBeenCalledTimes(1);
    } finally { await view.close(); }
  });

  it("opens frozen copies read-only while allowing full prompt inspection", async () => {
    stored = { ...stored, slug: "eval-frozen-immutable" };
    const view = await mount("/agents/agent-a");
    try {
      await settle(() => expect(name()?.value).toBe("Original name"));
      expect(name()?.disabled).toBe(true);
      expect(view.container.textContent).not.toContain("保存修改");
      expect(view.container.textContent).not.toContain("删除 Agent");
      expect([...view.container.querySelectorAll("button")].some((item) => item.textContent?.trim() === "管理")).toBe(false);
      expect(document.querySelector<HTMLTextAreaElement>('[aria-label="完整工作指令"]')?.readOnly).toBe(true);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(transport.post).not.toHaveBeenCalled();
      expect(transport.patch).not.toHaveBeenCalled();
    } finally { await view.close(); }
  });

  it("keeps a raced deletion conflict visible with the actual blocker", async () => {
    transport.delete.mockRejectedValueOnce(new ApiError({
      kind: "http", status: 409, code: "AGENT_CONFIG_ACTIVE_CHAT", message: "Blocked",
      details: { allowed: false, activeChatIds: ["00000000-0000-4000-8000-000000000001"], enabledScheduleIds: [], unfinishedRunIds: [] },
    }));
    const view = await mount("/agents/agent-a");
    try {
      await settle(() => expect(name()?.value).toBe("Original name"));
      await click(button("删除 Agent"));
      await settle(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
      await click(button("删除", document.querySelector('[role="alertdialog"]')!));
      await settle(() => expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("请先结束此 Agent 正在进行的会话"));
      expect(view.router.state.location.pathname).toBe("/agents/agent-a");
      expect(transport.delete).toHaveBeenCalledExactlyOnceWith("/api/agent-configs/agent-a");
    } finally { await view.close(); }
  });
});
