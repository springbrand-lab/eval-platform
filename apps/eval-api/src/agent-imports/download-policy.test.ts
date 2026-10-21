import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";
import {
  createImportDownloads, openImportStaging, safeImportPath, SOURCE_IMPORT_CDN_ORIGINS,
  TARGET_IMPORT_CDN_ORIGINS, IMPORT_CDN_ORIGINS,
} from "./bytes.js";

function downloads(purpose: "source" | "target", fetch: typeof globalThis.fetch = vi.fn()) {
  return createImportDownloads({ purpose, origin: `https://${purpose}.test`, fetch });
}

describe("deployment-scoped import byte policy", () => {
  it("allows the reviewed dev/eval CDNs only in their own direction, plus global platform content", () => {
    for (const origin of SOURCE_IMPORT_CDN_ORIGINS) {
      expect(downloads("source").validateUrl(`${origin}/skills/v1/SKILL.md`)).toContain(origin);
      expect(() => downloads("target").validateUrl(`${origin}/skills/v1/SKILL.md`)).toThrow();
    }
    for (const origin of TARGET_IMPORT_CDN_ORIGINS) {
      expect(downloads("target").validateUrl(`${origin}/uploads/v1/owner/id`)).toContain(origin);
      expect(() => downloads("source").validateUrl(`${origin}/uploads/v1/owner/id`)).toThrow();
    }
    for (const purpose of ["source", "target"] as const) for (const origin of IMPORT_CDN_ORIGINS) {
      expect(downloads(purpose).validateUrl(`${origin}/skills/platform/SKILL.md`)).toContain(origin);
    }
  });

  it("never blesses a target private Skill URL at the old dev origin, even if supplied as a misconfigured fixed origin", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const target = createImportDownloads({ origin: "https://creation-file-dev.springbrand.ai", purpose: "target", fetch });
    await expect(target.hash({ path: "SKILL.md", size: 3, url: "https://creation-file-dev.springbrand.ai/skills/v1/old/SKILL.md" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("permits an exact fixed API/static proxy origin or loopback test origin without allowing API/share endpoints or other ports", () => {
    const proxy = createImportDownloads({ origin: "http://127.0.0.1:8080", purpose: "source" });
    expect(proxy.validateUrl("http://127.0.0.1:8080/files/SKILL.md")).toBe("http://127.0.0.1:8080/files/SKILL.md");
    expect(() => proxy.validateUrl("http://127.0.0.1:8081/files/SKILL.md")).toThrow();
    expect(() => proxy.validateUrl("http://127.0.0.1:8080/api/user-agent-configs/id/share.zip")).toThrow();
    expect(() => downloads("target").validateUrl("https://creation-file-eval.springbrand.ai.evil.test/file")).toThrow();
  });

  it.each(["source", "target"] as const)("hashes a literal percent filename at its URI-encoded %s URL without rewriting it", async (purpose) => {
    const origin = purpose === "source" ? SOURCE_IMPORT_CDN_ORIGINS[0] : TARGET_IMPORT_CDN_ORIGINS[0];
    const url = `${origin}/users/owner/skills/percent-assets/versions/v1/percent-assets/assets/100%25.txt`;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("abc"));
    const file = { path: "assets/100%.txt", size: 3, url };
    await expect(downloads(purpose, fetch).hash(file)).resolves.toEqual({
      ...file, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
    expect(fetch.mock.calls.map(([address]) => address)).toEqual([url]);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    }
  });

  it.each([
    "/files/../SKILL.md", "/files/%2e/SKILL.md", "/files/%2e%2e/SKILL.md", "/files/%252e%252e/SKILL.md",
    "/files/a%2fb", "/files/a%2Fb", "/files/a%252fb", "/files/%5csecret", "/files/%00file",
    "/files/%255csecret", "/files/%2500file", "/files/%0afile", "/files/%250afile", "/files/%7ffile", "/files/%257ffile",
    "/files/C:/file", "/files/%43%3a/file", "/files//name", "/files/100%.txt", "/a/%2e%2e/b", "/a/%00",
    "/%61pi/user-agent-configs/id/share.zip",
  ])("rejects traversal and encoded separator path %s before fetching", async (pathname) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(downloads("target", fetch).hash({
      path: "SKILL.md", size: 3, url: `https://creation-file-eval.springbrand.ai${pathname}`,
    })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a long owner/version URL prefix and percent-encoded Chinese file names while keeping the logical 240-character ZIP budget", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eval-import-cdn-path-"));
    try {
      const store = await openImportStaging(directory);
      const task = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const logical = `${"中".repeat(237)}.md`; // exactly SP's public skillFile.path budget
      expect(logical).toHaveLength(240);
      expect(safeImportPath(logical)).toBe(logical);
      expect(() => safeImportPath(`${logical}x`)).toThrow();
      const prefix = `skills/v1/user/${crypto.randomUUID()}/stable-skill/${"a".repeat(64)}/`;
      const url = `https://creation-file-dev.springbrand.ai/${prefix}${encodeURIComponent(logical)}`;
      expect(new URL(url).pathname.length).toBeGreaterThan(240);
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("abc"));
      const source = downloads("source", fetch);
      const files = [
        await source.freeze(store, task, { path: "SKILL.md", size: 3, url: `https://creation-file-dev.springbrand.ai/${prefix}SKILL.md` }, expiresAt),
        await source.freeze(store, task, { path: logical, size: 3, url }, expiresAt),
      ];
      const zip = new ZipReader(new Uint8ArrayReader(await store.zip(task, files, expiresAt)));
      const entries = await zip.getEntries();
      expect(entries.map((entry) => entry.filename)).toEqual(["SKILL.md", logical]);
      for (const entry of entries) if (!entry.directory) expect(await entry.getData(new Uint8ArrayWriter())).toEqual(new TextEncoder().encode("abc"));
      await zip.close();
      for (const [, init] of fetch.mock.calls) {
        expect(init?.redirect).toBe("error");
        expect(init?.credentials).toBe("omit");
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      }
      expect(() => source.validateUrl(`https://creation-file-dev.springbrand.ai/${"a/".repeat(600)}x`)).toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
