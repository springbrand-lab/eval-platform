import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceTreeNode } from "@/api-sdk/observations-api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { click, render } from "@/test/render";
import { WorkspaceTab } from "./workspace-tab";

const getFile = vi.hoisted(() => vi.fn());
vi.mock("@/api-sdk/observations-api", async (original) => ({ ...await original<object>(), getWorkspaceFile: getFile }));
vi.mock("@/features/runs/use-run-polling", () => ({ POLL_MS: 20 }));
const createUrl = vi.fn();
const revokeUrl = vi.fn();
beforeEach(() => {
  getFile.mockReset(); createUrl.mockReset(); revokeUrl.mockReset();
  createUrl.mockImplementation(() => "blob:preview-" + createUrl.mock.calls.length);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createUrl;
    static revokeObjectURL = revokeUrl;
  });
});
afterEach(() => vi.unstubAllGlobals());

function textBlob(content: string | Promise<string>): Blob {
  const blob = new Blob([], { type: "text/plain" });
  Object.defineProperty(blob, "arrayBuffer", { value: async () => new TextEncoder().encode(await content).buffer });
  return blob;
}
const file = (path: string, version = 1): WorkspaceTreeNode => ({ path, name: path.split("/").at(-1)!, type: "file", updatedAt: version });
const button = (name: string) => [...document.querySelectorAll("button")].find((node) => node.textContent === name)!;

async function mount(initial: readonly WorkspaceTreeNode[], running = false) {
  let update!: (tree: readonly WorkspaceTreeNode[]) => void;
  function View() {
    const [tree, setTree] = useState(initial); update = setTree;
    return <WorkspaceTab projectId="project" kind="samplings" id="sampling" tree={tree} running={running} />;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<TooltipProvider><QueryClientProvider client={client}><View /></QueryClientProvider></TooltipProvider>);
  return {
    ...view,
    update: async (tree: readonly WorkspaceTreeNode[]) => { await act(async () => update(tree)); },
    cleanup: async () => { await view.unmount(); client.clear(); },
  };
}

it("uses the current tree version and discards a slow old text decode before it can replace the preview", async () => {
  let finishOld!: (text: string) => void;
  const oldBlob = textBlob(new Promise((resolve) => { finishOld = resolve; }));
  const latestBlob = textBlob("LATEST CONTENT");
  getFile.mockResolvedValueOnce(oldBlob).mockResolvedValueOnce(latestBlob);
  const view = await mount([file("/result.txt")]);
  try {
    await click(button("result.txt"));
    await vi.waitFor(() => expect(createUrl).toHaveBeenCalledWith(oldBlob));
    await view.update([file("/result.txt", 2)]);
    await vi.waitFor(() => expect(document.querySelector("pre")?.textContent).toBe("LATEST CONTENT"));
    expect(getFile).toHaveBeenCalledTimes(2);
    await act(async () => finishOld("STALE CONTENT"));
    expect(document.querySelector("pre")?.textContent).toBe("LATEST CONTENT");
    expect(createUrl).toHaveBeenCalledWith(latestBlob);
  } finally { await view.cleanup(); }
  expect(revokeUrl).toHaveBeenCalledWith("blob:preview-1");
  expect(revokeUrl).toHaveBeenCalledWith("blob:preview-2");
});

it("drops a removed selection and releases its download URL when the directory tree changes", async () => {
  getFile.mockResolvedValue(textBlob("CURRENT"));
  const view = await mount([{ name: "nested", path: "/nested", type: "directory", children: [file("/nested/result.txt")] }]);
  try {
    await click(button("result.txt"));
    await vi.waitFor(() => expect(document.querySelector("pre")?.textContent).toBe("CURRENT"));
    const download = document.querySelector("a[download]")!;
    expect(download.getAttribute("download")).toBe("result.txt");
    expect(download.querySelector("button")).toBeNull();
    await view.update([file("/other.txt")]);
    expect(document.querySelector("pre")).toBeNull();
    expect(document.querySelector("a[download]")).toBeNull();
    expect(document.body.textContent).toContain("选择左侧的文件查看内容");
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
  } finally { await view.cleanup(); }
});

it("reports parse read failures, preserves original download and retries the complete read", async () => {
  const unreadable = new Blob([], { type: "text/plain" });
  Object.defineProperty(unreadable, "arrayBuffer", { value: async () => { throw new Error("文本读取失败"); } });
  getFile.mockResolvedValueOnce(unreadable).mockResolvedValueOnce(textBlob("RECOVERED"));
  const view = await mount([file("/result.txt")]);
  try {
    await click(button("result.txt"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("文本读取失败"));
    expect(document.querySelector("a[download]")).not.toBeNull();
    await click(button("重试"));
    await vi.waitFor(() => expect(document.querySelector("pre")?.textContent).toBe("RECOVERED"));
    expect(getFile).toHaveBeenCalledTimes(2);
  } finally { await view.cleanup(); }
});

it("keeps the selected HTML view on new content and keeps the preview sandbox read-only", async () => {
  getFile.mockResolvedValueOnce(textBlob("<h1>old</h1>")).mockResolvedValueOnce(textBlob("<h1>latest</h1>"));
  const view = await mount([file("/index.html")]);
  try {
    await click(button("index.html"));
    await vi.waitFor(() => expect(button("Source")).toBeDefined());
    await click(button("Source"));
    expect(document.querySelector("pre")?.textContent).toBe("<h1>old</h1>");
    await view.update([file("/index.html", 2)]);
    await vi.waitFor(() => expect(document.querySelector("pre")?.textContent).toBe("<h1>latest</h1>"));
    await click(button("Preview"));
    await vi.waitFor(() => expect(document.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<h1>latest</h1>"));
    expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(document.querySelector("iframe")?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(revokeUrl).toHaveBeenCalledWith("blob:preview-1");
  } finally { await view.cleanup(); }
  expect(revokeUrl).toHaveBeenCalledWith("blob:preview-2");
});

it("refreshes a running file even when optional mtime and size cannot identify changed content", async () => {
  let changed = false;
  getFile.mockImplementation(async () => textBlob(changed ? "NEW" : "OLD"));
  const node: WorkspaceTreeNode = { path: "/result.txt", name: "result.txt", type: "file", size: 3 };
  const view = await mount([node], true);
  try {
    await click(button("result.txt"));
    await vi.waitFor(() => expect(document.querySelector("pre")?.textContent).toBe("OLD"));
    changed = true;
    await vi.waitFor(() => expect(document.querySelector("pre")?.textContent).toBe("NEW"));
    expect(getFile.mock.calls.length).toBeGreaterThan(1);
  } finally { await view.cleanup(); }
});
