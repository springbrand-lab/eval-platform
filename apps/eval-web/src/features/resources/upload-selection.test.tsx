import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { inputLimits } from "@/test/input-limits";
import { click, render, type } from "@/test/render";
import { BundleDetailPage } from "./bundle-detail-page";
import { ResourcesPage } from "./resources-page";

const writes = vi.hoisted(() => ({ create: vi.fn(), importZip: vi.fn(), createResource: vi.fn() }));
vi.mock("@/api-sdk/bundles-api", async (original) => {
  const actual = await original<typeof import("@/api-sdk/bundles-api")>();
  const catalog = {
    ...actual.materialBundles, ...writes, list: async () => [], listResources: async () => [],
    get: async () => ({ bundleId: "bundle", name: "素材包", description: "描述" }),
  };
  return { ...actual, materialBundles: catalog, resourceCatalog: () => catalog };
});
vi.mock("@/api-sdk/input-limits-api", async (original) => ({ ...await original<object>(), getInputLimits: async () => inputLimits }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
beforeEach(() => { Object.values(writes).forEach((mock) => mock.mockReset()); });
afterEach(() => vi.unstubAllGlobals());
const button = (text: string) => [...document.querySelectorAll("button")].find((node) => node.textContent === text)!;
const control = (label: string) => document.getElementById([...document.querySelectorAll("label")].find((node) => node.textContent === label)!.htmlFor)!;
async function choose(file: File) {
  const input = document.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function pendingDrop(file: File) {
  vi.stubGlobal("isSecureContext", true);
  let finish!: () => void;
  const value = new Promise<File>((resolve) => { finish = () => resolve(file); });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [], items: [{
    kind: "file", type: file.type, getAsFile: () => file,
    webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, name: file.name }),
    getAsFileSystemHandle: async () => ({ getFile: () => value }),
  }] } });
  await act(async () => { document.querySelector('input[type="file"]')!.parentElement!.dispatchEvent(event); });
  return () => act(async () => finish());
}

it.each([
  { mode: "create", open: "新建初始素材包", submit: "创建" },
  { mode: "zip", open: "导入 ZIP", submit: "导入" },
  { mode: "material", open: "新建素材", submit: "创建" },
])("$mode waits for browser extraction, keeping replacement and additive selections consistent", async (config) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}>
    {config.mode === "create" ? <ResourcesPage kind="material" /> : <BundleDetailPage kind="material" bundleId="bundle" />}
  </QueryClientProvider></TooltipProvider>);
  try {
    await vi.waitFor(() => expect(button(config.open)).toBeDefined());
    await click(button(config.open));
    if (config.mode !== "zip") { await type(control("名称"), "平台名称"); await type(control("说明"), "平台描述"); }
    const old = new File(["old"], config.mode === "material" ? "old.txt" : "old.zip", { type: config.mode === "material" ? "text/plain" : "application/zip" });
    await choose(old);
    expect(button(config.submit).disabled).toBe(false);
    const next = new File(["next"], config.mode === "material" ? "next.txt" : "next.zip", { type: old.type });
    const finish = await pendingDrop(next);
    expect(button(config.submit).disabled).toBe(true);
    await click(button(config.submit));
    Object.values(writes).forEach((mock) => expect(mock).not.toHaveBeenCalled());
    await finish();
    expect(button(config.submit).disabled).toBe(false);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(next.name);
    if (config.mode === "material") expect(dialog.textContent).toContain(old.name);
    else expect(dialog.textContent).not.toContain(old.name);
    if (config.mode === "create") {
      const late = await pendingDrop(new File(["late"], "late.zip", { type: "application/zip" }));
      await click(button("取消"));
      await click(button(config.open));
      await type(control("名称"), "新草稿"); await type(control("说明"), "新描述");
      const newest = await pendingDrop(new File(["newest"], "newest.zip", { type: "application/zip" }));
      await late();
      expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain("late.zip");
      expect(button(config.submit).disabled).toBe(true);
      await newest();
      expect(document.querySelector('[role="dialog"]')!.textContent).toContain("newest.zip");
      expect(button(config.submit).disabled).toBe(false);
    }
  } finally { await view.unmount(); client.clear(); }
});
