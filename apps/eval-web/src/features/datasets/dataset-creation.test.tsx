import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { click, render, select, type } from "@/test/render";
import { inputLimits } from "@/test/input-limits";
import { DatasetCreateDialog } from "./import-dialogs";

const api = vi.hoisted(() => ({ empty: vi.fn(), batch: vi.fn() }));
vi.mock("@/api-sdk/datasets-api", async (original) => ({ ...await original<object>(), createDataset: api.empty, importDataset: api.batch }));
vi.mock("@/api-sdk/input-limits-api", async (original) => ({ ...await original<object>(), getInputLimits: async () => inputLimits }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/api-sdk/bundles-api", () => ({ resourceCatalog: (kind: string) => ({
  keys: { list: () => [kind, "bundles"], resources: (id: string) => [kind, id] },
  list: async () => [{ bundleId: "10000000-0000-4000-8000-000000000001", name: "Context", description: "" }],
  listResources: async () => [{ sessionId: "10000000-0000-4000-8000-000000000002", name: "History", description: "" }],
}) }));

beforeEach(() => {
  for (const mock of Object.values(api)) { mock.mockReset(); mock.mockImplementation(() => new Promise(() => {})); }
});

const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name)!;
function control(name: string, scope: ParentNode = document) {
  const label = [...scope.querySelectorAll<HTMLLabelElement>("label")].find((item) => item.textContent?.replace(/\*/gu, "").trim() === name)!;
  return document.getElementById(label.htmlFor)!;
}

async function manual() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><DatasetCreateDialog onClose={vi.fn()} /></QueryClientProvider></TooltipProvider>);
  expect([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(["导入数据集", "手动创建"]);
  await click(button("手动创建"));
  await type(control("名称"), "Manual Dataset");
  await type(control("说明"), "Dataset description");
  return { close: async () => { await view.unmount(); client.clear(); } };
}

async function fillCase(name: string) {
  const editor = document.querySelector('[aria-label="用例编辑"]')!;
  for (const [label, value] of [["名称", name], ["说明", `${name} description`], ["执行 Prompt", `${name} execute`], ["评估 Prompt", `${name} evaluate`], ["JSON", '{"custom":{"retained":true}}']]) {
    await type(control(label!, editor), value!);
  }
}

it("allows an empty Dataset with shared name and description metadata, like resource Bundles", async () => {
  const view = await manual();
  try {
    expect(document.querySelector('[aria-label="用例编辑"]')).toBeNull();
    await vi.waitFor(() => expect(button("创建数据集").disabled).toBe(false));
    expect([...document.querySelectorAll("label")].some((label) => label.textContent === "描述")).toBe(false);
    await type(control("名称"), "");
    expect(button("创建数据集").disabled).toBe(true);
    await type(control("名称"), "Manual Dataset");
    await click(button("创建数据集"));
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledWith({ name: "Manual Dataset", description: "Dataset description" }));
    expect(api.batch).not.toHaveBeenCalled();
  } finally { await view.close(); }
});

it("edits multiple Data drafts through the existing fields and saves them in one batch", async () => {
  const view = await manual();
  try {
    await click(button("添加用例")); await fillCase("First");
    await select(document.querySelector('select[aria-label="执行上下文包"]'), "10000000-0000-4000-8000-000000000001");
    await vi.waitFor(() => expect(document.querySelector('select[aria-label="执行上下文"] option[value="10000000-0000-4000-8000-000000000002"]')).not.toBeNull());
    await select(document.querySelector('select[aria-label="执行上下文"]'), "10000000-0000-4000-8000-000000000002");
    await click(button("添加用例")); await fillCase("Second");
    await click(document.querySelector('button[aria-label="编辑用例 1"]'));
    expect((control("名称", document.querySelector('[aria-label="用例编辑"]')!) as HTMLInputElement).value).toBe("First");
    await fillCase("First revised");
    await click(button("创建数据集"));
    await vi.waitFor(() => expect(api.batch).toHaveBeenCalledTimes(1));
    expect(api.batch.mock.calls[0]![0]).toBe("json");
    const body = JSON.parse(api.batch.mock.calls[0]![1]);
    expect(body.dataset).toEqual({ name: "Manual Dataset", description: "Dataset description" });
    expect(body.data).toEqual(["First revised", "Second"].map((name, index) => ({
      name, description: `${name} description`, userPrompt: `${name} execute`, evalPrompt: `${name} evaluate`, custom: { retained: true },
      ...(index === 0 ? { initialSession: { bundleId: "10000000-0000-4000-8000-000000000001", sessionId: "10000000-0000-4000-8000-000000000002" } } : {}),
    })));
    expect(api.empty).not.toHaveBeenCalled();
  } finally { await view.close(); }
});

it("blocks invalid hidden drafts and allows removing a draft without losing another case", async () => {
  const view = await manual();
  try {
    await click(button("添加用例")); await fillCase("Keep");
    await click(button("添加用例"));
    await click(document.querySelector('button[aria-label="编辑用例 1"]'));
    expect(button("创建数据集").disabled).toBe(true);
    expect(document.body.textContent).toContain("用例 2");
    await click(document.querySelector('button[aria-label="移除用例 2"]'));
    expect(button("创建数据集").disabled).toBe(false);
    expect((control("名称", document.querySelector('[aria-label="用例编辑"]')!) as HTMLInputElement).value).toBe("Keep");
    await click(document.querySelector('button[aria-label="移除用例 1"]'));
    expect(document.querySelector('[aria-label="用例编辑"]')).toBeNull();
    expect(button("创建数据集").disabled).toBe(false);
    expect(api.empty).not.toHaveBeenCalled();
    expect(api.batch).not.toHaveBeenCalled();
  } finally { await view.close(); }
});
