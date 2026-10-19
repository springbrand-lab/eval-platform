import { expect, it, vi } from "vitest";
import { projectHtmlPreview } from "@springbrand/file-renderers/html/preview";
import { fileResources, type ReadPreviewFile } from "./file-resources";

it.each(["https://example.com/private", "//example.com/image.png", "data:text/plain,hello", "file%5Cname.txt"])("does not read blocked reference %s", async (reference) => {
  const read = vi.fn<ReadPreviewFile>();
  const signal = new AbortController().signal;
  await expect(fileResources(read, signal).resolve({ basePath: "/", reference, purpose: "image" }, { signal })).resolves.toMatchObject({ status: "blocked" });
  expect(read).not.toHaveBeenCalled();
});

it("binds linked reads to the selected source and aborts them when the preview lifetime ends", async () => {
  let finish!: (value: Blob) => void;
  const read = vi.fn<ReadPreviewFile>(() => new Promise<Blob>((resolve) => { finish = resolve; }));
  const controller = new AbortController();
  const resource = fileResources(read, controller.signal);
  const result = resource.resolve({ basePath: "/pages", reference: "../styles.css", purpose: "stylesheet" }, { signal: new AbortController().signal });
  expect(read).toHaveBeenCalledWith("/styles.css", expect.any(AbortSignal));
  const signal = read.mock.calls[0][1] as AbortSignal;
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  expect(signal.aborted).toBe(true);
  finish({ type: "text/css", arrayBuffer: async () => new ArrayBuffer(0) } as Blob);
  await rejected;
});

it.each(["图 #1?.png", "100%.png", "literal%20.png"])("reads the exact %s inventory path through the real HTML projector", async (name) => {
  const read = vi.fn<ReadPreviewFile>(async () => ({ type: "image/png", arrayBuffer: async () => new Uint8Array([1]).buffer }) as Blob);
  const controller = new AbortController();
  const result = await projectHtmlPreview({ name: "index.html", mimeType: "text/html", text: `<img src="${encodeURIComponent(name)}">` },
    { basePath: "/images #?%", resources: fileResources(read, controller.signal), signal: controller.signal });
  expect(read).toHaveBeenCalledExactlyOnceWith(`/images #?%/${name}`, expect.any(AbortSignal));
  expect(result.unavailableResources).toBe(0);
  expect(result.document).toContain("data:image/png;base64,AQ==");
});

it("blocks a linked file above the preview's remaining byte budget without copying it", async () => {
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(4));
  const read = vi.fn<ReadPreviewFile>(async () => ({ type: "image/png", size: 4, arrayBuffer }) as unknown as Blob);
  const signal = new AbortController().signal;
  await expect(fileResources(read, signal).resolve({ basePath: "/", reference: "a.png", purpose: "image" }, { signal, maxBytes: 3 }))
    .resolves.toMatchObject({ status: "blocked" });
  expect(arrayBuffer).not.toHaveBeenCalled();
});
