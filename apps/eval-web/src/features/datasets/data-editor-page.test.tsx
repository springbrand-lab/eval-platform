import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Data } from "@eval-platform/eval-dataset";
import { ApiError } from "@springbrand/http/client";
import { click, render, type } from "@/test/render";
import { DataEditorPage, NewDataPage } from "./data-editor-page";

const fixture = vi.hoisted(() => ({
  dataId: "10000000-0000-4000-8000-000000000001", name: "原名称", description: "原描述", userPrompt: "原启动", evalPrompt: "原评估",
  custom: { retained: [1, true, null] },
}));
const update = vi.hoisted(() => vi.fn(async (_id: string, data: unknown) => ({ ...data as object, dataId: fixture.dataId })));
const get = vi.hoisted(() => vi.fn<() => Promise<Data>>());
const create = vi.hoisted(() => vi.fn(async (input: unknown, _options: unknown) => ({ ...input as object, dataId: fixture.dataId })));
const attach = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/api-sdk/data-api", async (original) => ({ ...await original<object>(), getData: get, updateData: update, createData: create }));
vi.mock("@/api-sdk/datasets-api", async (original) => ({ ...await original<object>(), attachData: attach }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ children, to, params = {} }: { children: React.ReactNode; to: string; params?: Record<string, string> }) =>
    <a href={to.replace(/\$(\w+)/gu, (_, key: string) => params[key] ?? "")}>{children}</a>,
}));
vi.mock("@/api-sdk/bundles-api", () => ({ resourceCatalog: (kind: string) => ({
  keys: { list: () => [kind, "bundles"], resources: (id: string) => [kind, id] },
  list: async () => [], listResources: async () => [],
}) }));

function control(container: HTMLElement, label: string) {
  const element = [...container.querySelectorAll("label")].find((item) => item.textContent?.replace("*", "").trim() === label);
  if (!element) throw new Error(`Missing label ${label}`);
  return container.ownerDocument.getElementById(element.htmlFor) as HTMLInputElement | HTMLTextAreaElement;
}

async function fillNewData(container: HTMLElement) {
  for (const [label, value] of [["名称", "Case"], ["描述", "Task"], ["启动 Prompt", "Execute"], ["评估 Prompt", "Judge"]]) {
    await type(control(container, label!), value!);
  }
}

describe("uploaded sample editor", () => {
  beforeEach(() => {
    get.mockReset(); get.mockResolvedValue(fixture); update.mockClear(); attach.mockClear(); navigate.mockClear();
    create.mockReset(); create.mockImplementation(async (input) => ({ ...input as object, dataId: fixture.dataId }));
  });
  it("creates a sample once in its Dataset", async () => {
    const datasetId = "20000000-0000-4000-8000-000000000001";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = await render(<QueryClientProvider client={queryClient}><NewDataPage datasetId={datasetId} /></QueryClientProvider>);
    try {
      await fillNewData(view.container);
      await click([...view.container.querySelectorAll("button")].find((button) => button.textContent === "创建用例"));
      await vi.waitFor(() => expect(create).toHaveBeenCalledExactlyOnceWith({ name: "Case", description: "Task", userPrompt: "Execute", evalPrompt: "Judge" }, { datasetId }));
      expect(attach).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/datasets/$datasetId", params: { datasetId } }));
    } finally { await view.unmount(); queryClient.clear(); }
  });

  it("refreshes the catalog, freezes the draft and links to its Dataset after an unconfirmed create", async () => {
    const datasetId = "20000000-0000-4000-8000-000000000001";
    create.mockRejectedValue(new ApiError({ code: "NETWORK_ERROR", kind: "network", status: 0, message: "ack lost" }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const view = await render(<QueryClientProvider client={queryClient}><NewDataPage datasetId={datasetId} /></QueryClientProvider>);
    try {
      await fillNewData(view.container);
      const submit = () => [...view.container.querySelectorAll("button")].find((button) => button.textContent === "创建用例")!;
      await click(submit());
      await vi.waitFor(() => expect(view.container.textContent).toContain("提交结果尚未确认"));
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["data"] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["datasets"] });
      expect(control(view.container, "名称").matches(":disabled")).toBe(true);
      expect(control(view.container, "名称").value).toBe("Case");
      expect(submit().disabled).toBe(true);
      expect([...view.container.querySelectorAll("a")].find((link) => link.textContent === "返回数据集核对用例")?.getAttribute("href"))
        .toBe(`/datasets/${datasetId}`);
      await click(submit());
      expect(create).toHaveBeenCalledTimes(1);
      expect(attach).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    } finally { await view.unmount(); queryClient.clear(); }
  });

  it("edits all four required fields and preserves other business data after save/refetch", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = await render(<QueryClientProvider client={queryClient}><DataEditorPage dataId={fixture.dataId} /></QueryClientProvider>);
    try {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      const control = (label: string) => {
        const element = [...view.container.querySelectorAll("label")].find((item) => item.textContent?.replace("*", "").trim() === label);
        if (!element) throw new Error(`Missing label ${label}`);
        return view.container.ownerDocument.getElementById(element.htmlFor) as HTMLInputElement | HTMLTextAreaElement;
      };
      for (const [label, value] of [["名称", "新名称"], ["描述", "新描述"], ["启动 Prompt", "新启动\n原文"], ["评估 Prompt", "新评估\n原文"]]) {
        expect(control(label!).required).toBe(true);
        await type(control(label!), value!);
      }
      await click([...view.container.querySelectorAll("button")].find((button) => button.textContent === "保存修改"));
      await vi.waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith(fixture.dataId, {
        name: "新名称", description: "新描述", userPrompt: "新启动\n原文", evalPrompt: "新评估\n原文", custom: fixture.custom,
      }));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(control("名称").value).toBe("新名称");
    } finally {
      await view.unmount(); queryClient.clear();
    }
  });

  it("keeps an unsaved draft through a failed background refresh and recovery", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(<QueryClientProvider client={queryClient}><DataEditorPage dataId={fixture.dataId} /></QueryClientProvider>);
    try {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      const label = [...view.container.querySelectorAll("label")].find((item) => item.textContent === "名称*")!;
      const name = () => document.getElementById(label.htmlFor) as HTMLInputElement;
      await type(name(), "尚未保存的名称");
      get.mockRejectedValueOnce(new Error("temporary outage"));
      await act(async () => { await queryClient.invalidateQueries({ queryKey: ["data"] }); await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(name().value).toBe("尚未保存的名称");
      expect(view.container.textContent).toContain("temporary outage");
      await act(async () => { await queryClient.invalidateQueries({ queryKey: ["data"] }); await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(name().value).toBe("尚未保存的名称");
      expect(update).not.toHaveBeenCalled();
    } finally {
      await view.unmount(); queryClient.clear();
    }
  });
});
