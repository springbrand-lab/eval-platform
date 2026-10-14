import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openBundleDirectory } from "./bundle-directory.js";

const owner = "11111111-1111-4111-8111-111111111111";
const otherOwner = "22222222-2222-4222-8222-222222222222";
const bundleId = "project/assets.1";
const materialId = "homepage/files";
const sessionId = "previous.chat";
const encoded = (id: string) => encodeURIComponent(id).replaceAll(".", "%2E");
const roots: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "eval-bundle-"));
  roots.push(directory);
  return directory;
}

async function put(directory: string, path: string, content: string): Promise<void> {
  const target = join(directory, owner, encoded(bundleId), path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Eval Bundle directory", () => {
  it("uploads and reads one user's material and optional JSONL Session independently", async () => {
    const directory = await root();
    const files = [{ path: "/brief.txt", mediaType: "text/plain", contentBase64: "SGVsbG8=" }];
    const source = await openBundleDirectory(directory);
    await source.uploadInitialMaterials(owner, { bundleId, materialId }, files);
    await source.uploadInitialSession(owner, { bundleId, sessionId }, {
      format: "jsonl", content: '{"id":"m1","message":{"role":"user","content":"Hi"},"createdAt":1}\n',
    });
    await expect(source.resolveInitialMaterials(owner, { bundleId, materialId })).resolves.toEqual(files);
    await expect(source.resolveInitialSession(owner, { bundleId, sessionId })).resolves.toMatchObject({
      format: "jsonl", content: expect.stringContaining('"id":"m1"'),
    });
    await expect(source.resolveInitialMaterials(otherOwner, { bundleId, materialId }))
      .rejects.toMatchObject({ retryable: false });
    await expect(source.resolveInitialSession(owner, { bundleId, sessionId: "missing" }))
      .resolves.toBeUndefined();
    await source.uploadInitialMaterials(owner, { bundleId, materialId }, files);
    await expect(source.uploadInitialMaterials(owner, { bundleId, materialId }, [
      { path: "/other.txt", mediaType: "text/plain", contentBase64: "SGk=" },
    ])).rejects.toMatchObject({ retryable: false });
  });

  it("rejects malformed manifests, invalid Session content and files outside the Bundle root", async () => {
    const directory = await root();
    await put(directory, `materials/${encoded(materialId)}.json`, '{"files":[{"path":1}]}');
    await put(directory, `sessions/${encoded(sessionId)}.json`, '{"format":"jsonl","content":false}');
    const source = await openBundleDirectory(directory);
    await expect(source.resolveInitialMaterials(owner, { bundleId, materialId }))
      .rejects.toMatchObject({ retryable: false });
    await expect(source.resolveInitialSession(owner, { bundleId, sessionId }))
      .rejects.toMatchObject({ retryable: false });
    await expect(source.uploadInitialSession(owner, { bundleId, sessionId: "bad" },
      { format: "jsonl", content: "not-json" })).rejects.toMatchObject({ retryable: false });

    const outside = await root();
    const outsideFile = join(outside, "private.json");
    await writeFile(outsideFile, JSON.stringify({ files: [] }));
    const manifest = join(directory, owner, encoded(bundleId), "materials", `${encoded(materialId)}.json`);
    await rm(manifest);
    await symlink(outsideFile, manifest);
    await expect(source.resolveInitialMaterials(owner, { bundleId, materialId }))
      .rejects.toMatchObject({ retryable: false });
  });

  it("does not follow a Bundle link into another user's directory", async () => {
    const directory = await root();
    const source = await openBundleDirectory(directory);
    const files = [{ path: "/brief.txt", mediaType: "text/plain", contentBase64: "SGk=" }];
    const context = { format: "json" as const, content: JSON.stringify({ entries: [
      { id: "m1", message: { role: "user", content: "Hello" }, createdAt: 1 },
    ] }) };
    await source.uploadInitialMaterials(otherOwner, { bundleId, materialId }, files);
    await source.uploadInitialSession(otherOwner, { bundleId, sessionId }, context);
    await mkdir(join(directory, owner));
    await symlink(join(directory, otherOwner, encoded(bundleId)),
      join(directory, owner, encoded(bundleId)), "dir");

    await expect(source.resolveInitialMaterials(owner, { bundleId, materialId }))
      .rejects.toMatchObject({ retryable: false });
    await expect(source.resolveInitialSession(owner, { bundleId, sessionId }))
      .rejects.toMatchObject({ retryable: false });
    await expect(source.uploadInitialMaterials(owner, { bundleId, materialId: "new" }, files))
      .rejects.toMatchObject({ retryable: false });
    await expect(source.uploadInitialSession(owner, { bundleId, sessionId: "new" }, context))
      .rejects.toMatchObject({ retryable: false });
    await expect(source.resolveInitialMaterials(otherOwner, { bundleId, materialId })).resolves.toEqual(files);
    await expect(source.resolveInitialMaterials(otherOwner, { bundleId, materialId: "new" }))
      .rejects.toMatchObject({ retryable: false });
    await expect(source.resolveInitialSession(otherOwner, { bundleId, sessionId: "new" }))
      .resolves.toBeUndefined();
  });

  it("applies upload validation when reading an existing material manifest", async () => {
    const directory = await root();
    const source = await openBundleDirectory(directory);
    for (const [resourceId, file] of [
      ["unsafe-path", { path: "/../secret.txt", mediaType: "text/plain", contentBase64: "SGk=" }],
      ["bad-base64", { path: "/brief.txt", mediaType: "text/plain", contentBase64: "not base64" }],
    ] as const) {
      await put(directory, `materials/${encoded(resourceId)}.json`, JSON.stringify({ files: [file] }));
      await expect(source.resolveInitialMaterials(owner, { bundleId, materialId: resourceId }))
        .rejects.toMatchObject({ retryable: false });
    }
  });

  it("rejects syntactically valid Session content that SP cannot import", async () => {
    const source = await openBundleDirectory(await root());
    for (const [resourceId, context] of [
      ["no-entries", { format: "json", content: "{}" }],
      ["wrong-first-role", { format: "json", content: JSON.stringify({ entries: [
        { id: "m1", message: { role: "assistant" }, createdAt: 1 },
      ] }) }],
      ["duplicate-id", { format: "jsonl", content: [
        { id: "m1", message: { role: "user" }, createdAt: 1 },
        { id: "m1", message: { role: "assistant" }, createdAt: 2 },
      ].map((entry) => JSON.stringify(entry)).join("\n") }],
    ] as const) {
      await expect(source.uploadInitialSession(owner, { bundleId, sessionId: resourceId }, context))
        .rejects.toMatchObject({ retryable: false });
    }
  });

  it("requires an absolute directory at startup", async () => {
    await expect(openBundleDirectory("relative/bundles")).rejects.toThrow(/absolute path/u);
  });
});
