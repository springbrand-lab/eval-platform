import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@springbrand/http/client";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { inputLimits } from "@/test/input-limits";
import { click, render, type } from "@/test/render";
import { ResourcesPage } from "./resources-page";

const catalog = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), keys: { all: ["bundles", "material"], list: () => ["bundles", "material", "list"] } }));
vi.mock("@/api-sdk/bundles-api", () => ({ resourceCatalog: () => catalog }));
vi.mock("@/api-sdk/input-limits-api", async (original) => ({ ...await original<object>(), getInputLimits: async () => inputLimits }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
beforeEach(() => { catalog.list.mockReset(); catalog.list.mockResolvedValue([]); catalog.create.mockReset(); });

it("refreshes an uncertain create and requires catalog inspection before another submission", async () => {
  catalog.create.mockImplementation(async () => {
    catalog.list.mockResolvedValue([{ bundleId: "created", name: "已提交的包", description: "描述" }]);
    throw new ApiError({ code: "NETWORK_ERROR", kind: "network", status: 0, message: "ack lost" });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><ResourcesPage kind="material" /></QueryClientProvider></TooltipProvider>);
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await click([...view.container.querySelectorAll("button")].find((item) => item.textContent === "新建初始素材包"));
    const control = (label: string) => document.getElementById([...document.querySelectorAll("label")].find((item) => item.textContent === label)!.htmlFor)!;
    await type(control("名称"), "已提交的包"); await type(control("描述"), "描述");
    await click([...document.querySelectorAll("button")].find((item) => item.textContent === "创建"));
    await vi.waitFor(() => expect(catalog.list.mock.calls.length).toBeGreaterThan(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(document.body.textContent).toContain("提交结果尚未确认");
    expect(([...document.querySelectorAll("button")].find((item) => item.textContent === "创建") as HTMLButtonElement).disabled).toBe(true);
    await click([...document.querySelectorAll("button")].find((item) => item.textContent === "取消"));
    expect(view.container.textContent).toContain("已提交的包");
    expect(catalog.create).toHaveBeenCalledTimes(1);
  } finally { await view.unmount(); client.clear(); }
});
