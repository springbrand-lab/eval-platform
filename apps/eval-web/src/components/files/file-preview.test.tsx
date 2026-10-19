import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { click, render } from "@/test/render";
import { FilePreview } from "./file-preview";
import type { ReadPreviewFile } from "./file-resources";

const createUrl = vi.fn();
const revokeUrl = vi.fn();
beforeEach(() => {
  createUrl.mockReset().mockImplementation(() => `blob:preview-${createUrl.mock.calls.length}`);
  revokeUrl.mockReset();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = createUrl; static revokeObjectURL = revokeUrl; });
});
afterEach(() => vi.unstubAllGlobals());

function textBlob(content: string, type = "text/html"): Blob {
  const blob = new Blob([content], { type });
  Object.defineProperty(blob, "arrayBuffer", { value: async () => new TextEncoder().encode(content).buffer });
  return blob;
}
const button = (name: string) => [...document.querySelectorAll("button")].find((node) => node.textContent === name);

async function mount(readFile: ReadPreviewFile, path = "/pages/index.html") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(<QueryClientProvider client={client}>
    <FilePreview file={{ path, name: path.split("/").at(-1)! }} queryKey={["preview", path]} readFile={readFile} />
  </QueryClientProvider>);
  return { ...view, cleanup: async () => { await view.unmount(); client.clear(); } };
}

it("renders HTML with nested CSS, images and scripts of its Website through the bound reader", async () => {
  // The page's directory roots its Website: `../outside.css` is above it and never read.
  const files = new Map([
    ["/pages/index.html", textBlob('<link rel="stylesheet" href="css/main.css"><link rel="stylesheet" href="../outside.css"><img src="img/logo.svg"><script src="js/app.js"></script>')],
    ["/pages/css/main.css", textBlob('body{background:url(../img/background.png)}', "text/css")],
    ["/pages/img/logo.svg", textBlob('<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml")],
    ["/pages/img/background.png", textBlob("IMAGE", "image/png")],
    ["/pages/js/app.js", textBlob('document.body.dataset.loaded="true";', "application/javascript")],
  ]);
  const read = vi.fn<ReadPreviewFile>(async (path) => {
    const value = files.get(path);
    if (!value) throw new Error(`Unexpected file ${path}`);
    return value;
  });
  const view = await mount(read);
  try {
    await vi.waitFor(() => expect(document.querySelector("iframe")?.getAttribute("srcdoc")).toContain(`;base64,${btoa('document.body.dataset.loaded="true";')}`));
    expect(read.mock.calls.map(([path]) => path).sort()).toEqual([...files.keys()].sort());
    expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(document.querySelector("a[download]")?.getAttribute("download")).toBe("index.html");
  } finally { await view.cleanup(); }
});

it("retries a linked-resource failure using the host reload action", async () => {
  let failed = true;
  const read = vi.fn<ReadPreviewFile>(async (path) => {
    if (path === "/pages/index.html") return textBlob('<link rel="stylesheet" href="style.css"><h1>Source</h1>');
    if (failed) throw new Error("Temporary stylesheet failure");
    return textBlob("h1{color:red}", "text/css");
  });
  const view = await mount(read);
  try {
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("HTML preview unavailable"));
    expect(document.querySelector("a[download]")).not.toBeNull();
    failed = false;
    await click(document.querySelector('button[aria-label="重新加载文件"]'));
    await vi.waitFor(() => expect(document.querySelector("iframe")?.getAttribute("srcdoc")).toContain("data:text/css;charset=utf-8;base64,"));
    expect(read.mock.calls.filter(([path]) => path === "/pages/style.css")).toHaveLength(2);
  } finally { await view.cleanup(); }
});

it("cancels linked reads on file change and discards their late results", async () => {
  let finish!: (value: Blob) => void;
  let linkedSignal!: AbortSignal;
  const read = vi.fn<ReadPreviewFile>(async (path, signal) => {
    if (path === "/pages/index.html") return textBlob('<link rel="stylesheet" href="style.css"><h1>OLD</h1>');
    if (path === "/pages/style.css") {
      linkedSignal = signal;
      return new Promise<Blob>((resolve) => { finish = resolve; });
    }
    return textBlob("SECOND CONTENT", "text/plain");
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Host() {
    const [path, setPath] = useState("/pages/index.html");
    return <><button onClick={() => setPath("/other.txt")}>Next file</button><FilePreview key={path}
      file={{ path, name: path.split("/").at(-1)! }} queryKey={["preview", path]} readFile={read} /></>;
  }
  const view = await render(<QueryClientProvider client={client}><Host /></QueryClientProvider>);
  try {
    await vi.waitFor(() => expect(linkedSignal).toBeDefined());
    await click(button("Next file"));
    await vi.waitFor(() => expect(document.querySelector("pre")?.textContent).toBe("SECOND CONTENT"));
    expect(linkedSignal.aborted).toBe(true);
    await act(async () => finish(textBlob("body{color:red}", "text/css")));
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("pre")?.textContent).toBe("SECOND CONTENT");
  } finally { await view.unmount(); client.clear(); }
  for (let index = 1; index <= createUrl.mock.calls.length; index += 1) expect(revokeUrl).toHaveBeenCalledWith(`blob:preview-${index}`);
});

it("retains exact Source and original download after a real CSV parse failure", async () => {
  const original = 'a,b\n"unterminated,field';
  const view = await mount(async () => textBlob(original, "text/csv"), "/broken.csv");
  try {
    await vi.waitFor(() => expect(button("Source")).toBeDefined());
    expect(document.querySelector("a[download]")).not.toBeNull();
    await click(button("Source"));
    expect(document.querySelector("pre")?.textContent).toBe(original);
  } finally { await view.cleanup(); }
});
