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
const template: UserAgentConfigTemplate = { name: "New Agent", description: null, setting };
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
      if (path === "/api/agent-library/user-agent-configs/agent-a/deletion-check") return {
        allowed: true, activeChatIds: [], enabledScheduleIds: [], unfinishedRunIds: [],
      };
      throw new Error(`Unexpected GET ${path}`);
    });
    transport.request.mockImplementation(async (path: string) => {
      const url = new URL(path, "http://eval.test");
      if (url.pathname === "/api/agent-library/models") return [];
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

  it("creates with the SP template, prompt dialog, resource selector and validated settings", async () => {
    const view = await mount();
    try {
      await settle(() => expect(name()).not.toBeNull());
      expect(view.container.textContent).not.toContain("Slug");
      expect(view.container.textContent).not.toContain("setting JSON");
      for (const section of ["Behavior", "Model", "Thinking", "Connectors", "Component Connectors", "Extensions", "Actions", "Skills", "References"]) {
        expect(view.container.textContent).toContain(section);
      }
      await type(name(), "  Research Agent  ");
      await type(document.querySelector("#agent-description"), "Research description");
      await click(button("Template instructionsClick to view and edit the full prompt"));
      await type(document.querySelector('[aria-label="Full system prompt"]'), "Updated instructions");
      await click(button("Done", document.querySelector('[role="dialog"]')!));
      await select(document.querySelector("#agent-thinking"), "high");
      await click(document.querySelector('[aria-label="Add Skills"]'));
      await settle(() => expect(document.querySelector('[aria-label="Select Research Skill"]')).not.toBeNull());
      await click(document.querySelector('[aria-label="Select Research Skill"]'));
      await click(button("Save changes", document.querySelector('[role="dialog"]')!));
      await click(button("Create Agent"));
      await settle(() => expect(transport.post).toHaveBeenCalledTimes(1));
      expect(transport.post.mock.calls[0]).toEqual(["/api/agent-configs", {
        slug: expect.stringMatching(/^agent-[\da-f-]{36}$/u), name: "Research Agent", description: "Research description",
        setting: { ...setting, systemPrompt: "Updated instructions", thinking: "high", skillIds: ["skill-a"] },
      }]);
      await settle(() => expect(view.router.state.location.pathname).toBe("/agents/agent-a"));
      expect(transport.request.mock.calls.some(([path]) => path.startsWith("/api/agent-library/skills?") && path.includes("view=selectable"))).toBe(true);
    } finally { await view.close(); }
  });

  it("cancels creation without writing a config", async () => {
    const view = await mount();
    try {
      await settle(() => expect(name()).not.toBeNull());
      await type(name(), "Discard me");
      await click(button("Cancel"));
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
      await click(button("Create Agent"));
      await settle(() => expect(transport.post).toHaveBeenCalledTimes(1));
      const request = transport.post.mock.calls[0]![1];
      transport.get.mockImplementationOnce(async () => { throw new Error("Template temporarily unavailable"); });
      await act(async () => { await view.query.invalidateQueries({ queryKey: agentLibraryKeys.template }); });
      await settle(() => expect(view.container.textContent).toContain("Template temporarily unavailable"));
      expect(name()?.value).toBe("Keep my draft");
      await click(button("重试"));
      await settle(() => expect(view.container.textContent).not.toContain("Template temporarily unavailable"));
      expect(name()?.value).toBe("Keep my draft");
      await click(button("Create Agent"));
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
      await click(button("Save changes"));
      await settle(() => expect(transport.patch).toHaveBeenCalledExactlyOnceWith("/api/agent-configs/agent-a", {
        revision: 3, name: "Unsaved name", description: null, setting,
      }));
    } finally { await view.close(); }
  });

  it("retains the draft after a revision conflict", async () => {
    transport.patch.mockRejectedValueOnce(new ApiError({ kind: "http", code: "AGENT_CONFIG_REVISION_CONFLICT", status: 409, message: "Conflict" }));
    const view = await mount("/agents/agent-a");
    try {
      await settle(() => expect(name()?.value).toBe("Original name"));
      await type(name(), "My version");
      await click(button("Save changes"));
      await settle(() => expect(view.container.textContent).toContain("Your edits are still here"));
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
      expect(view.container.textContent).not.toContain("Save changes");
      expect(view.container.textContent).not.toContain("Delete Agent");
      expect(view.container.textContent).not.toContain("Manage");
      await click(button("Template instructionsClick to view and edit the full prompt"));
      expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Full system prompt"]')?.readOnly).toBe(true);
      expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Done");
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
      await click(button("Delete Agent"));
      await settle(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
      await click(button("删除", document.querySelector('[role="alertdialog"]')!));
      await settle(() => expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Finish this Agent's active Chat work"));
      expect(view.router.state.location.pathname).toBe("/agents/agent-a");
      expect(transport.delete).toHaveBeenCalledExactlyOnceWith("/api/agent-configs/agent-a");
    } finally { await view.close(); }
  });
});
