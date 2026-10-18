import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@/api-sdk/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { click, render } from "@/test/render";
import { AgentsPage } from "./agents-page";

const mocks = vi.hoisted(() => ({
  configs: vi.fn(), options: vi.fn(), models: vi.fn(),
}));
vi.mock("@/api-sdk/agent-configs-api", () => ({
  agentKeys: { list: () => ["agents", "configs", "list"], options: (role?: string) => ["agents", "options", role ?? "all"] },
  listAgentConfigs: mocks.configs,
  listAgentOptions: mocks.options,
}));
vi.mock("@/api-sdk/agent-editor-api", () => ({
  agentLibraryKeys: { models: ["agent-library", "models"] },
  agentEditorClient: { models: { listModelCatalog: mocks.models } },
}));

function config(id: string): AgentConfig {
  return {
    id, user_id: "owner", slug: id, name: id === "executor" ? "执行配置" : "评估配置", description: `${id} description`,
    revision: 1, setting_schema_version: 4,
    setting: {
      presetId: null, model: "model", thinking: "medium", systemPrompt: null,
      toolPolicy: { allow: [], deny: [] }, subagentNames: [], executionLevel: "safe",
      memoryDefaults: { enabled: false, memoryTokens: 100, preferencesTokens: 50 }, sandbox: { enabled: false },
      skillIds: [], mcpServers: [], actionIds: [], connectorIds: [], extensionIds: [], referenceFileIds: [],
    },
    is_default: false, created_at: 1, updated_at: 1,
  } as AgentConfig;
}

async function mount() {
  window.scrollTo = vi.fn();
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({ getParentRoute: () => root, path: "/agents", component: AgentsPage });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/agents"] }) });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={query}><RouterProvider router={router} /></QueryClientProvider></TooltipProvider>);
  await act(async () => { await vi.waitFor(() => expect(view.container.querySelector("tbody tr")).not.toBeNull()); });
  return { ...view, query };
}

describe("Agent management purpose filter", () => {
  it("shows purpose badges and filters the table without changing the source list", async () => {
    mocks.configs.mockResolvedValue([config("executor"), config("evaluator")]);
    mocks.models.mockResolvedValue([{ id: "model", name: "DeepSeek V4.1 Flash", providerModel: "model", thinking: "high", thinkingLevels: ["high"] }]);
    mocks.options.mockResolvedValue([
      { agentConfig: { ownerUserId: "owner", userAgentId: "executor" }, name: "执行配置", role: "subject", purpose: "execution" },
      { agentConfig: { ownerUserId: "owner", userAgentId: "evaluator" }, name: "评估配置", role: "evaluator", purpose: "evaluation" },
    ]);
    const view = await mount();
    try {
      expect(view.container.textContent).toContain("执行 Agent");
      expect(view.container.textContent).toContain("评估 Agent");
      expect(view.container.textContent).toContain("DeepSeek V4.1 Flash");
      expect(view.container.textContent).toContain("适中");
      expect(view.container.querySelectorAll("tbody tr")).toHaveLength(2);

      const evaluatorFilter = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((button) => button.textContent?.includes("评估 Agent"));
      await click(evaluatorFilter);
      expect(view.container.querySelectorAll("tbody tr")).toHaveLength(1);
      expect(view.container.querySelector("tbody")?.textContent).toContain("评估配置");
      expect(view.container.querySelector("tbody")?.textContent).not.toContain("执行配置");

      const executionFilter = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((button) => button.textContent?.includes("执行 Agent"));
      await click(executionFilter);
      expect(view.container.querySelector("tbody")?.textContent).toContain("执行配置");
      expect(view.container.querySelector("tbody")?.textContent).not.toContain("评估配置");
    } finally {
      await view.unmount();
      view.query.clear();
    }
  });
});
