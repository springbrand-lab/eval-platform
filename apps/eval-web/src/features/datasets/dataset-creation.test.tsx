import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { click, render, type } from "@/test/render";
import { inputLimits } from "@/test/input-limits";
import { DatasetCreateDialog, DatasetImportDialog } from "./import-dialogs";

const api = vi.hoisted(() => ({ empty: vi.fn(), append: vi.fn(), navigate: vi.fn() }));
vi.mock("@/api-sdk/datasets-api", async (original) => ({ ...await original<object>(), createDataset: api.empty, importDatasetData: api.append }));
vi.mock("@/api-sdk/input-limits-api", async (original) => ({ ...await original<object>(), getInputLimits: async () => inputLimits }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => api.navigate }));
beforeEach(() => { Object.values(api).forEach((mock) => mock.mockReset()); api.empty.mockResolvedValue({ datasetId: "dataset", name: "My dataset" }); api.append.mockResolvedValue([]); });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name)!;
async function mount(importing = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}>{importing ? <DatasetImportDialog datasetId="dataset" onClose={vi.fn()} /> : <DatasetCreateDialog onClose={vi.fn()} />}</QueryClientProvider></TooltipProvider>);
  return async () => { await view.unmount(); client.clear(); };
}
async function choose(rows: unknown) {
  const file = new File([JSON.stringify(rows)], "cases.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => JSON.stringify(rows) });
  const input = document.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}
const row = { name: "Case", description: "Details", userPrompt: "Execute", evalPrompt: "Evaluate" };
it("creates with only a name and goes to the single maintenance workspace", async () => {
  const close = await mount();
  try {
    expect(document.querySelector('[role="tab"]')).toBeNull();
    expect(document.body.textContent).not.toContain("执行任务");
    await type(document.querySelector('input')!, "My dataset");
    await click(button("创建数据集"));
    await vi.waitFor(() => expect(api.empty).toHaveBeenCalledExactlyOnceWith({ name: "My dataset" }));
    await vi.waitFor(() => expect(api.navigate).toHaveBeenCalledWith({ to: "/datasets/$datasetId", params: { datasetId: "dataset" } }));
  } finally { await close(); }
});
it("previews and appends the whole file in one request", async () => {
  const close = await mount(true);
  try {
    await choose([row, { ...row, name: "Second" }]);
    await vi.waitFor(() => expect(button("确认导入").disabled).toBe(false));
    expect(document.querySelector('[aria-label="导入预览"]')?.textContent).toContain("2 条用例");
    await click(button("确认导入"));
    await vi.waitFor(() => expect(api.append).toHaveBeenCalledExactlyOnceWith("dataset", { format: "json", content: JSON.stringify([row, { ...row, name: "Second" }]) }));
  } finally { await close(); }
});
it("rejects the whole batch when a later row is invalid or carries resource references", async () => {
  const close = await mount(true);
  try {
    await choose([row, { ...row, evalPrompt: " " }]);
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(button("确认导入").disabled).toBe(true);
    await choose([{ ...row, initialMaterials: [{ bundleId: "10000000-0000-4000-8000-000000000001", materialId: "10000000-0000-4000-8000-000000000002" }] }]);
    await vi.waitFor(() => expect(document.body.textContent).toContain("resource references"));
    expect(api.append).not.toHaveBeenCalled();
  } finally { await close(); }
});
