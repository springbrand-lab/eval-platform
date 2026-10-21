import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";
import { createImportDownloads, openImportStaging, safeImportPath } from "./bytes.js";
import { IMPORT_LIMITS } from "./model.js";

const task = "11111111-1111-4111-8111-111111111111";
const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function staging() {
  const root = await mkdtemp(path.join(tmpdir(), "eval-import-test-"));
  cleanup.push(root);
  return { root, store: await openImportStaging(root) };
}

describe("frozen import bytes", () => {
  it("preserves literal percent filenames and complete bytes through downloads, staging and Skill ZIP packing", async () => {
    const { store } = await staging();
    const base = "https://creation-file-dev.springbrand.ai/users/source-owner/skills/percent-assets/versions/v1/percent-assets";
    const sourceFiles = [
      { path: "SKILL.md", url: `${base}/SKILL.md`,
        bytes: new TextEncoder().encode("---\nname: percent-assets\ndescription: Keep original assets\n---\nUse the assets.\n") },
      { path: "assets/100%.txt", url: `${base}/assets/100%25.txt`, bytes: new Uint8Array([0, 13, 10, 37, 128, 255, 0]) },
      { path: "assets/100%25.txt", url: `${base}/assets/100%2525.txt`, bytes: new TextEncoder().encode("literal %25\r\n") },
      { path: "assets/rate%20data.txt", url: `${base}/assets/rate%2520data.txt`, bytes: new TextEncoder().encode("not a space\n") },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      const file = sourceFiles.find((file) => file.url === url);
      if (!file) throw new Error(`Unexpected download: ${url}`);
      return new Response(file.bytes);
    });
    const downloads = createImportDownloads({ origin: "https://dev.test", purpose: "source", fetch });
    const expires = new Date(Date.now() + 60_000).toISOString();
    const files = [];
    for (const file of sourceFiles) {
      files.push(await downloads.freeze(store, task, { path: file.path, size: file.bytes.byteLength, url: file.url }, expires));
    }
    const reader = new ZipReader(new Uint8ArrayReader(await store.zip(task, files, expires)));
    try {
      const entries = await reader.getEntries();
      expect(entries.map((entry) => entry.filename)).toEqual(["SKILL.md", "assets/100%.txt", "assets/100%25.txt", "assets/rate%20data.txt"]);
      for (const [index, entry] of entries.entries()) {
        expect(entry.directory).toBe(false);
        if (!entry.directory) expect(await entry.getData(new Uint8ArrayWriter())).toEqual(sourceFiles[index]!.bytes);
      }
    } finally { await reader.close(); }
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(sourceFiles.map((file) => file.url));
  });

  it("streams every Skill file, freezes hashes and packs all paths, with no token on CDN requests", async () => {
    const { store } = await staging();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("abc"));
    const downloads = createImportDownloads({ origin: "https://dev.test", purpose: "source", fetch });
    const expires = new Date(Date.now() + 60_000).toISOString();
    const files = [];
    for (const name of ["SKILL.md", "scripts/main.py", "assets/example.bin"]) {
      files.push(await downloads.freeze(store, task, { path: name, size: 3, url: `https://dev.test/${name}` }, expires));
    }
    const zip = await store.zip(task, files, expires);
    const reader = new ZipReader(new Uint8ArrayReader(zip));
    const entries = await reader.getEntries();
    expect(entries.map((item) => item.filename)).toEqual(files.map((item) => item.path));
    for (const entry of entries) {
      expect(entry.directory).toBe(false);
      if (!entry.directory) expect(await entry.getData(new Uint8ArrayWriter())).toEqual(new TextEncoder().encode("abc"));
    }
    await reader.close();
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
    }
    await expect(store.read(task, files[0]!, expires)).resolves.toEqual(new TextEncoder().encode("abc"));
    await expect(store.read(task, files[0]!, "2000-01-01T00:00:00.000Z")).rejects.toThrow(/expired/i);
  });

  it.each(["", ".", "..", "./a", "../a", "/a", "//a", "a/../b", "a/./b", "a//b", "a/", "a\\b",
    "a/\u0000", "a/\u001f", "a/\u007f", "C:/a", "c:a"])("rejects unsafe literal paths %s", (name) => {
    expect(() => safeImportPath(name)).toThrow();
  });

  it.each(["http://remote.test/x", "https://evil.test/x", "https://dev.test.evil.test/x", "https://user:pass@dev.test/x",
    "https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://dev.test/x#fragment",
    "https://dev.test/api/user-agent-configs/x/share.zip", "https://dev.test/%61pi/user-agent-configs/x/share.zip"])(
    "rejects untrusted download %s without issuing a request", async (url) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const downloads = createImportDownloads({ origin: "https://dev.test", purpose: "source", fetch });
      const { store } = await staging();
      await expect(downloads.freeze(store, task, { path: "SKILL.md", size: 1, url }, new Date(Date.now() + 60_000).toISOString())).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });

  it("rejects redirect responses, truncated/oversized bodies, corrupted cache and symlink task paths", async () => {
    const { store, root } = await staging();
    const expiry = new Date(Date.now() + 60_000).toISOString();
    for (const response of [new Response("abc", { status: 302 }), new Response("ab"), new Response("abcd")]) {
      const download = createImportDownloads({ origin: "https://dev.test", purpose: "source", fetch: async () => response });
      await expect(download.freeze(store, task, { path: "SKILL.md", size: 3, url: "https://dev.test/file" }, expiry)).rejects.toThrow();
    }
    const download = createImportDownloads({ origin: "https://dev.test", purpose: "source", fetch: async () => new Response("abc") });
    const file = await download.freeze(store, task, { path: "SKILL.md", size: 3, url: "https://dev.test/file" }, expiry);
    await writeFile(path.join(root, "imports", task, file.sha256), "xyz");
    expect(await readFile(path.join(root, "imports", task, file.sha256), "utf8")).toBe("xyz");
    await expect(store.read(task, file, expiry)).rejects.toThrow(/hash/i);
    const other = "22222222-2222-4222-8222-222222222222";
    await symlink(root, path.join(root, "imports", other));
    await expect(download.freeze(store, other, { path: "SKILL.md", size: 3, url: "https://dev.test/file" }, expiry)).rejects.toThrow();
  });

  it("enforces single-file, aggregate stream byte and file-count budgets before the next request", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({
      start(controller) {
        for (let index = 0; index < 20; index++) controller.enqueue(chunk);
        controller.close();
      },
    })));
    const downloads = createImportDownloads({ origin: "https://dev.test", purpose: "source", fetch });
    await expect(downloads.hash({ path: "file", size: IMPORT_LIMITS.fileBytes + 1, url: "https://dev.test/file" })).rejects.toThrow(/limit/i);
    expect(fetch).not.toHaveBeenCalled();
    const file = { path: "file", size: IMPORT_LIMITS.fileBytes, url: "https://dev.test/file" };
    for (let index = 0; index < 10; index++) await downloads.hash(file);
    expect(downloads.bytesRead).toBe(IMPORT_LIMITS.totalBytes);
    await expect(downloads.hash(file)).rejects.toThrow(/limit/i);
    expect(fetch).toHaveBeenCalledTimes(10);
    const emptyFetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new Uint8Array()));
    const empty = createImportDownloads({ origin: "https://dev.test", purpose: "source", fetch: emptyFetch });
    for (let index = 0; index < IMPORT_LIMITS.files; index++) await empty.hash({ ...file, size: 0 });
    await expect(empty.hash({ ...file, size: 0 })).rejects.toThrow(/limit/i);
    expect(emptyFetch).toHaveBeenCalledTimes(IMPORT_LIMITS.files);
  });
});
