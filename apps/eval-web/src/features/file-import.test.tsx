import { ApiError } from "@springbrand/http/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { inputLimits } from "@/test/input-limits";
import { click, render, select, type } from "@/test/render";
import { DatasetsPage } from "./datasets/datasets-page";
import { OutputSchemasPage } from "./output-schemas/output-schemas-page";

const api = vi.hoisted(() => ({ prompt: vi.fn(), document: vi.fn(), schema: vi.fn() }));
vi.mock("@/api-sdk/datasets-api", async (original) => ({ ...await original<object>(), importPromptDataset: api.prompt, importDataset: api.document, listDatasets: async () => [] }));
vi.mock("@/api-sdk/output-schemas-api", async (original) => ({ ...await original<object>(), createOutputSchema: api.schema, listOutputSchemas: async () => [] }));
vi.mock("@/api-sdk/input-limits-api", async (original) => ({ ...await original<object>(), getInputLimits: async () => inputLimits }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

const row = { name: "Case", description: "Case details", userPrompt: "Do task", evalPrompt: "Judge task", custom: { kept: [1, true, null] } };
const schema = JSON.stringify({ type: "object", properties: { category: { enum: ["good", "bad"] } }, required: ["category"], additionalProperties: false }, null, 2);
const configs = [
  { kind: "dataset", open: "导入数据集", tab: "导入数据集", submit: "确认导入", file: "data.jsonl", content: JSON.stringify(row), mock: api.prompt, key: "datasets" },
  { kind: "schema", open: "新建评估结果格式", tab: "导入评估结果格式", submit: "创建评估结果格式", file: "schema.json", content: schema, mock: api.schema, key: "output-schemas" },
] as const;

beforeEach(() => {
  for (const mock of Object.values(api)) { mock.mockReset(); mock.mockImplementation(() => new Promise(() => {})); }
});

const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
const control = (text: string) => document.getElementById([...document.querySelectorAll<HTMLLabelElement>("label")].find((item) => item.textContent?.replace(/\*/gu, "").trim() === text)!.htmlFor) as HTMLInputElement;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
function deferredFile(name: string, mime = "application/json") {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  const file = new File(["file"], name, { type: mime });
  Object.defineProperty(file, "text", { value: () => pending });
  return { file, resolve, reject };
}
async function choose(file: File) {
  const input = document.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function page(config: typeof configs[number], fill = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}>{config.kind === "dataset" ? <DatasetsPage /> : <OutputSchemasPage />}</QueryClientProvider></TooltipProvider>);
  await vi.waitFor(() => expect(button(config.open)).toBeDefined());
  await click(button(config.open));
  if (config.kind === "schema") await click(button(config.tab));
  if (fill) { await type(control("名称"), "Typed name"); await type(control("说明"), "Typed explanation"); }
  return { client, close: async () => { await view.unmount(); client.clear(); } };
}

it.each(configs)("$kind uses shared metadata with no raw-content controls and retains it across modes", async (config) => {
  const view = await page(config);
  try {
    const dialog = document.querySelector('[role="dialog"]')!;
    expect([...dialog.querySelectorAll("label")].map((item) => item.textContent?.replace(/\*/gu, ""))).toEqual(["名称", "说明"]);
    expect(dialog.querySelector("textarea, select, details")).toBeNull();
    if (config.kind === "schema") {
      expect([...dialog.querySelectorAll('[role="tab"]')].map((item) => item.textContent)).toEqual([config.tab, "手动创建"]);
      await click(button("手动创建")); await click(button(config.tab));
    }
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(control("名称").value).toBe("Typed name");
    expect(control("说明").value).toBe("Typed explanation");
    expect(button(config.submit).disabled).toBe(true);
  } finally { await view.close(); }
});

it.each(configs)("$kind submits only the latest file and freezes edits during submission", async (config) => {
  const view = await page(config);
  try {
    const old = deferredFile("old.json");
    const latest = deferredFile(config.file);
    await choose(old.file); await choose(latest.file);
    expect(button(config.submit).disabled).toBe(true);
    expect(control("名称").matches(":disabled")).toBe(false);
    await act(async () => latest.resolve(config.content));
    await act(async () => old.resolve('{"outdated":true}'));
    await click(button(config.submit));
    await settle();
    await vi.waitFor(() => expect(config.mock).toHaveBeenCalledTimes(1));
    expect(config.mock.mock.calls[0]![0]).toMatchObject({ name: "Typed name", description: "Typed explanation", content: config.content });
    if (config.kind === "dataset") expect(config.mock.mock.calls[0]![0].format).toBe("jsonl");
    expect(control("名称").matches(":disabled")).toBe(true);
    expect((document.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(true);
    if (config.kind === "schema") expect(button("手动创建").getAttribute("aria-disabled")).toBe("true");
  } finally { await view.close(); }
});

it.each(configs)("$kind allows retrying failed reads and invalidates reads superseded by rejected files", async (config) => {
  const view = await page(config);
  try {
    const failed = deferredFile("failed.json");
    await choose(failed.file); await act(async () => failed.reject(new Error("read failed")));
    expect(document.body.textContent).toContain("无法读取「failed.json」");
    expect(button(config.submit).disabled).toBe(true);
    const old = deferredFile(config.file);
    await choose(old.file);
    await choose(new File(["invalid"], "rejected.bin", { type: "application/octet-stream" }));
    await act(async () => old.resolve(config.content));
    expect(button(config.submit).disabled).toBe(true);
    const retry = deferredFile(config.file);
    await choose(retry.file); await act(async () => retry.resolve(config.content));
    expect(button(config.submit).disabled).toBe(false);
    expect(config.mock).not.toHaveBeenCalled();
  } finally { await view.close(); }
});

it.each(configs)("$kind cancels a late read on mode changes and starts fresh after reopening", async (config) => {
  const view = await page(config);
  try {
    const late = deferredFile(config.file);
    await choose(late.file);
    if (config.kind === "schema") await click(button("手动创建"));
    else { await click(button("取消")); await click(button(config.open)); await type(control("名称"), "Typed name"); }
    await act(async () => late.resolve(config.content));
    if (config.kind === "schema") await click(button(config.tab));
    expect(button(config.submit).disabled).toBe(true);
    expect(document.body.textContent).not.toContain(`已选择：${config.file}`);
    expect(control("名称").value).toBe("Typed name");
    await click(button("取消")); await click(button(config.open));
    if (config.kind === "schema") await click(button(config.tab));
    expect(control("名称").value).toBe("");
    expect(control("说明").value).toBe("");
    expect(button(config.submit).disabled).toBe(true);
  } finally { await view.close(); }
});

it.each(configs)("$kind refreshes its catalog and prevents duplicate writes after an unknown outcome", async (config) => {
  config.mock.mockRejectedValue(new ApiError({ kind: "network", code: "NETWORK_ERROR", status: 0, message: "ack lost" }));
  const view = await page(config);
  try {
    const invalidate = vi.spyOn(view.client, "invalidateQueries");
    const file = deferredFile(config.file);
    await choose(file.file); await act(async () => file.resolve(config.content));
    await click(button(config.submit));
    await settle();
    await vi.waitFor(() => expect(document.body.textContent).toContain("提交结果尚未确认"));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [config.key] });
    expect(control("说明").matches(":disabled")).toBe(true);
    if (config.kind === "schema") expect(button("手动创建").getAttribute("aria-disabled")).toBe("true");
    if (config.kind === "schema") { await click(button("手动创建"));
      expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(config.tab); }
    expect(button(config.submit).disabled).toBe(true);
    await click(button(config.submit));
    expect(config.mock).toHaveBeenCalledTimes(1);
  } finally { await view.close(); }
});

it.each([
  ["CASES.JSON", "application/json", "json"],
  ["CASES.JSONL", "application/json", "jsonl"],
  ["download.data", "application/json", "json"],
] as const)("detects the Dataset file %s without exposing a format selector", async (filename, mime, format) => {
  const view = await page(configs[0]);
  try {
    const file = deferredFile(filename, mime);
    await choose(file.file);
    await act(async () => file.resolve(JSON.stringify(format === "json" ? [row] : row)));
    await click(button("确认导入"));
    await vi.waitFor(() => expect(api.prompt).toHaveBeenCalledTimes(1));
    expect(api.prompt.mock.calls[0]![0].format).toBe(format);
  } finally { await view.close(); }
});

it.each(["DATASET.YAML", "download.data"])("imports %s with edited metadata while preserving IDs and all Data fields", async (filename) => {
  const view = await page(configs[0]);
  try {
    const file = deferredFile(filename, "application/yaml");
    await choose(file.file);
    await act(async () => file.resolve(`dataset:\n  datasetId: 10000000-0000-4000-8000-000000000001\n  name: File name\n  description: File explanation\ndata:\n  - dataId: 10000000-0000-4000-8000-000000000002\n    name: Case\n    description: Case details\n    userPrompt: Do task\n    evalPrompt: Judge task\n    custom:\n      kept: [1, true, null]\n`));
    expect(control("名称").value).toBe("Typed name");
    expect(control("说明").value).toBe("Typed explanation");
    await click(button("确认导入"));
    await vi.waitFor(() => expect(api.document).toHaveBeenCalledTimes(1));
    expect(api.document.mock.calls[0]![0]).toBe("json");
    expect(JSON.parse(api.document.mock.calls[0]![1])).toEqual({
      dataset: { datasetId: "10000000-0000-4000-8000-000000000001", name: "Typed name", description: "Typed explanation" },
      data: [{ ...row, dataId: "10000000-0000-4000-8000-000000000002" }],
    });
  } finally { await view.close(); }
});

it("seeds Dataset metadata from a complete file without replacing edits made during its read", async () => {
  const view = await page(configs[0], false);
  try {
    const file = deferredFile("dataset.json");
    await choose(file.file);
    await type(control("名称"), "Name entered while reading");
    await act(async () => file.resolve(JSON.stringify({ dataset: { name: "File name", description: "File explanation" }, data: [row] })));
    await vi.waitFor(() => expect(control("说明").value).toBe("File explanation"));
    expect(control("名称").value).toBe("Name entered while reading");
  } finally { await view.close(); }
});

it("rejects oversized prompt files even when the whole-Dataset file limit is larger", async () => {
  const view = await page(configs[0]);
  try {
    const file = deferredFile("large.jsonl");
    await choose(file.file);
    await act(async () => file.resolve(JSON.stringify({ ...row, extra: "x".repeat(inputLimits.promptDatasetFileBytes) })));
    expect(document.body.textContent).toContain("超过大小上限");
    expect(button("确认导入").disabled).toBe(true);
  } finally { await view.close(); }
});

it("checks the decoded Dataset file size before normalizing its document", async () => {
  const view = await page(configs[0]);
  try {
    const file = deferredFile("padded.json");
    await choose(file.file);
    await act(async () => file.resolve(" ".repeat(inputLimits.datasetDocumentBytes) + JSON.stringify({
      dataset: { name: "Padded", description: "A small document with oversized whitespace" }, data: [row],
    })));
    expect(button("确认导入").disabled).toBe(true);
    expect(document.body.textContent).toContain("超过大小上限");
  } finally { await view.close(); }
});

it("creates a scoring format through friendly fields and keeps complex imports separate", async () => {
  const view = await page(configs[1]);
  try {
    const file = deferredFile("schema.json");
    await choose(file.file); await act(async () => file.resolve(schema));
    await click(button("手动创建"));
    await type(document.querySelector('input[aria-label="字段 1 下限"]')!, "20");
    expect(button("创建评估结果格式").disabled).toBe(true);
    await type(document.querySelector('input[aria-label="字段 1 上限"]')!, "100");
    await click(button("添加字段"));
    await type(document.querySelector('input[aria-label="字段 3 标识"]')!, "passed");
    await select(document.querySelector('select[aria-label="字段 3 类型"]'), "boolean");
    await click(button("导入评估结果格式"));
    expect(button("创建评估结果格式").disabled).toBe(false);
    await click(button("手动创建"));
    expect((document.querySelector('input[aria-label="字段 1 下限"]') as HTMLInputElement).value).toBe("20");
    await click(button("创建评估结果格式"));
    await vi.waitFor(() => expect(api.schema).toHaveBeenCalledTimes(1));
    const output = JSON.parse(api.schema.mock.calls[0]![0].content);
    expect(output.properties).toMatchObject({ score: { type: "number", minimum: 20, maximum: 100 }, passed: { type: "boolean" } });
    expect(output.properties).not.toHaveProperty("category");
  } finally { await view.close(); }
});
