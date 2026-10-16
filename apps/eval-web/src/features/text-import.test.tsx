import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { inputLimits } from "@/test/input-limits";
import { click, render, type } from "@/test/render";
import { BundleDetailPage } from "./resources/bundle-detail-page";

const api = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("@/api-sdk/bundles-api", async (original) => {
  const actual = await original<typeof import("@/api-sdk/bundles-api")>();
  const catalog = { ...actual.sessionBundles, createResource: api.session, get: async () => ({ bundleId: "bundle", name: "上下文包", description: "说明" }), listResources: async () => [] };
  return { ...actual, sessionBundles: catalog, resourceCatalog: () => catalog };
});
vi.mock("@/api-sdk/input-limits-api", async (original) => ({ ...await original<object>(), getInputLimits: async () => inputLimits }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.session.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => vi.unstubAllGlobals());

const cases = [
  { feature: "session", open: "新建上下文", submit: "创建", contentLabel: "内容", mock: api.session },
] as const;

function deferredFile(name: string, type = "application/json") {
  let resolve!: (content: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  const file = new File(["file"], name, { type });
  const read = vi.fn(() => promise);
  Object.defineProperty(file, "text", { value: read });
  return { file, resolve, reject, read };
}

const button = (text: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === text)!;
const control = (label: string) => document.getElementById([...document.querySelectorAll("label")].find((item) => item.textContent === label)!.htmlFor)!;
async function choose(file: File) {
  const input = document.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}

async function openImport(config: typeof cases[number]) {
  await vi.waitFor(() => expect(button(config.open)).toBeDefined());
  await click(button(config.open));
}

async function openForm(config: typeof cases[number]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}>
    <BundleDetailPage kind="session" bundleId="bundle" />
  </QueryClientProvider></TooltipProvider>);
  await openImport(config);
  await vi.waitFor(() => expect(control(config.contentLabel)).toBeDefined());
  // Complete platform metadata so only file state gates submission.
  await type(control("名称"), "上下文"); await type(control("说明"), "说明");
  return { ...view, cleanup: async () => { await view.unmount(); client.clear(); }, client };
}

it.each(cases)("$feature submits the latest file with its format and blocks submission while reading", async (config) => {
  const view = await openForm(config);
  try {
    const first = deferredFile("first.json");
    const second = deferredFile("latest.jsonl");
    await type(control(config.contentLabel), '{"previous":true}');
    await choose(first.file); await choose(second.file);
    expect((control(config.contentLabel) as HTMLTextAreaElement).value).toBe("");
    expect(button(config.submit).disabled).toBe(true);
    await act(async () => second.resolve('{"latest":true}'));
    await act(async () => first.resolve('{"old":true}'));
    expect((control(config.contentLabel) as HTMLTextAreaElement).value).toBe('{"latest":true}');
    await click(button(config.submit));
    await vi.waitFor(() => expect(config.mock).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const body = config.mock.mock.calls[0]![1];
    expect(body.content).toBe('{"latest":true}');
    expect(body.format).toBe("jsonl");
    expect(control(config.contentLabel).matches(":disabled")).toBe(true);
    expect((document.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(true);
  } finally { await view.cleanup(); }
});

it.each(cases)("$feature handles failed reads, lets edits supersede reads and resets the draft after closing", async (config) => {
  const view = await openForm(config);
  try {
    const failed = deferredFile("unreadable.json");
    await type(control(config.contentLabel), '{"previous":true}');
    await choose(failed.file);
    await act(async () => failed.reject(new Error("disk read failed")));
    expect(document.body.textContent).toContain("无法读取「unreadable.json」");
    expect((control(config.contentLabel) as HTMLTextAreaElement).value).toBe("");
    expect(button(config.submit).disabled).toBe(true);
    const slow = deferredFile("slow.json");
    await choose(slow.file); await type(control(config.contentLabel), '{"edited":true}');
    await act(async () => slow.reject(new Error("late failure")));
    expect((control(config.contentLabel) as HTMLTextAreaElement).value).toBe('{"edited":true}');
    expect(document.body.textContent).not.toContain("无法读取");
    expect(button(config.submit).disabled).toBe(false);
    const closed = deferredFile("closed.json");
    await choose(closed.file); await click(button("取消"));
    await openImport(config);
    await act(async () => closed.resolve('{"closed":true}'));
    expect((control(config.contentLabel) as HTMLTextAreaElement).value).toBe("");
    expect(config.mock).not.toHaveBeenCalled();
  } finally { await view.cleanup(); }
});

it.each(cases)("$feature invalidates a slow older read when a replacement is rejected", async (config) => {
  const view = await openForm(config);
  try {
    const old = deferredFile("old.json");
    await choose(old.file);
    const rejected = new File(["binary"], "latest.bin", { type: "application/octet-stream" });
    await choose(rejected);
    expect(document.body.textContent).toContain("latest.bin：文件类型或数量不符合要求");
    await act(async () => old.resolve('{"old":true}'));
    expect((control(config.contentLabel) as HTMLTextAreaElement).value).toBe("");
    expect(button(config.submit).disabled).toBe(true);
    expect(config.mock).not.toHaveBeenCalled();
  } finally { await view.cleanup(); }
});

it.each(cases)("$feature recognizes accepted uppercase file extensions", async (config) => {
  const view = await openForm(config);
  try {
    const file = deferredFile("DATA.JSON");
    await choose(file.file); await act(async () => file.resolve('{"content":true}'));
    await click(button(config.submit));
    await vi.waitFor(() => expect(config.mock).toHaveBeenCalledTimes(1));
    expect(config.mock.mock.calls[0]![1].format).toBe("json");
  } finally { await view.cleanup(); }
});

async function delayedDrop(file: File) {
  vi.stubGlobal("isSecureContext", true);
  let resolve!: (file: File) => void;
  let reject!: (error: Error) => void;
  const extracted = new Promise<File>((yes, no) => { resolve = yes; reject = no; });
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: {
    types: ["Files"], files: [], items: [{
      kind: "file", type: file.type, getAsFile: () => file,
      webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, name: file.name, fullPath: "/" + file.name }),
      getAsFileSystemHandle: async () => ({ getFile: () => extracted }),
    }],
  } });
  await act(async () => { document.querySelector('input[type="file"]')!.parentElement!.dispatchEvent(drop); });
  return { finish: () => resolve(file), fail: () => reject(new Error("file handle unavailable")) };
}

it.each(cases)("$feature supersedes an older file while the browser is still extracting its handle", async (config) => {
  const view = await openForm(config);
  try {
    const old = deferredFile("old.json");
    const extraction = await delayedDrop(old.file);
    expect(button(config.submit).disabled).toBe(true);
    const latest = deferredFile("latest.json");
    await choose(latest.file); await act(async () => latest.resolve('{"latest":true}'));
    await act(async () => extraction.finish());
    expect(old.read).not.toHaveBeenCalled();
    expect((control(config.contentLabel) as HTMLTextAreaElement).value).toBe('{"latest":true}');
  } finally { await view.cleanup(); }
});

it.each(cases)("$feature keeps a manual edit when pending file extraction later finishes or rejects the file", async (config) => {
  const view = await openForm(config);
  try {
    for (const [name, mime] of [["old.json", "application/json"], ["old.png", "image/png"]]) {
      const old = deferredFile(name!, mime!);
      const extraction = await delayedDrop(old.file);
      await type(control(config.contentLabel), '{"edited":true}');
      await act(async () => extraction.finish());
      expect(old.read).not.toHaveBeenCalled();
      expect((control(config.contentLabel) as HTMLTextAreaElement).value).toBe('{"edited":true}');
      expect(document.body.textContent).not.toContain("文件类型或数量不符合要求");
      expect(button(config.submit).disabled).toBe(false);
    }
  } finally { await view.cleanup(); }
});

it.each(cases)("$feature exits the reading state after browser extraction fails", async (config) => {
  const view = await openForm(config);
  try {
    const extraction = await delayedDrop(deferredFile("unavailable.json").file);
    await act(async () => extraction.fail());
    expect(document.body.textContent).toContain("无法读取所选文件");
    expect(document.body.textContent).not.toContain("正在读取文件");
    expect(button(config.submit).disabled).toBe(true);
    await type(control(config.contentLabel), '{"edited":true}');
    expect(button(config.submit).disabled).toBe(false);
  } finally { await view.cleanup(); }
});

it.each(cases)("$feature recognizes an accepted MIME when the filename has no format extension", async (config) => {
  const view = await openForm(config);
  try {
    const file = deferredFile("download.data", "application/json");
    await choose(file.file); await act(async () => file.resolve('{"content":true}'));
    expect((control("格式") as HTMLSelectElement).value).toBe("json");
    await click(button(config.submit));
    await vi.waitFor(() => expect(config.mock).toHaveBeenCalledTimes(1));
  } finally { await view.cleanup(); }
});

it("does not change a draft on hover and ends an empty-folder selection", async () => {
  const config = cases[0];
  const view = await openForm(config);
  try {
    await type(control(config.contentLabel), '{"edited":true}');
    const zone = document.querySelector('input[type="file"]')!.parentElement!;
    for (const type of ["dragenter", "dragleave"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], items: [{ kind: "file", type: "application/json" }] } });
      await act(async () => { zone.dispatchEvent(event); });
    }
    expect((control(config.contentLabel) as HTMLTextAreaElement).value).toBe('{"edited":true}');
    expect(button(config.submit).disabled).toBe(false);
    const empty = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(empty, "dataTransfer", { value: { types: ["Files"], items: [], files: [] } });
    await act(async () => { zone.dispatchEvent(empty); });
    expect(document.body.textContent).toContain("没有可读取的文件");
    expect(document.body.textContent).not.toContain("正在读取文件");
    expect(button(config.submit).disabled).toBe(true);
  } finally { await view.cleanup(); }
});

it("keeps platform metadata entered while the session file handle is still extracting", async () => {
  const view = await openForm(cases[0]);
  try {
    await type(control("名称"), "");
    const file = deferredFile("filename.json");
    const extraction = await delayedDrop(file.file);
    expect(control("格式").matches(":disabled")).toBe(true);
    await type(control("名称"), "平台填写的名称");
    await type(control("说明"), "平台填写的说明");
    await act(async () => extraction.finish());
    await act(async () => file.resolve('{"content":true}'));
    expect((control("名称") as HTMLInputElement).value).toBe("平台填写的名称");
    expect((control("说明") as HTMLInputElement).value).toBe("平台填写的说明");
    expect(control("格式").matches(":disabled")).toBe(false);
    await click(button("创建"));
    await vi.waitFor(() => expect(api.session).toHaveBeenCalledTimes(1));
    expect(api.session.mock.calls[0]![1]).toMatchObject({ name: "平台填写的名称", description: "平台填写的说明", format: "json" });
  } finally { await view.cleanup(); }
});
