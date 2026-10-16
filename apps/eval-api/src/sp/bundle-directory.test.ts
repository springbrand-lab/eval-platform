import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openBundleDirectory } from "./bundle-directory.js";
import type { BundleFileErrorReason } from "./bundle-errors.js";

const owner = "11111111-1111-4111-8111-111111111111";
const otherOwner = "22222222-2222-4222-8222-222222222222";
const bundleId = "33333333-3333-4333-8333-333333333333";
const materialId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const resourceId = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
const files = [{ path: "/brief.txt", mediaType: "text/plain", contentBase64: "SGVsbG8=" }];
const userEntry = (id: string) => JSON.stringify({ id, message: { role: "user", content: "Hi" }, createdAt: 1 });
const roots: string[] = [];

const failure = (reason: BundleFileErrorReason) => ({ name: "BundleFileError", reason, retryable: reason === "unavailable" });

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "eval-bundle-"));
  roots.push(directory);
  return directory;
}

async function put(directory: string, path: string, content: string): Promise<void> {
  const target = join(directory, owner, bundleId, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Eval Bundle directory", () => {
  it("uploads and reads one user's material and optional JSONL Session independently", async () => {
    const source = await openBundleDirectory(await root());
    await expect(source.uploadInitialMaterials(owner, { bundleId, materialId }, files)).resolves.toBe(5);
    await source.uploadInitialSession(owner, { bundleId, sessionId }, { format: "jsonl", content: `${userEntry("m1")}\n` });
    await expect(source.resolveInitialMaterials(owner, { bundleId, materialId })).resolves.toEqual(files);
    await expect(source.resolveInitialSession(owner, { bundleId, sessionId }))
      .resolves.toEqual({ format: "jsonl", content: `${userEntry("m1")}\n` });
    await expect(source.resolveInitialMaterials(otherOwner, { bundleId, materialId })).rejects.toMatchObject(failure("not-found"));
    await expect(source.resolveInitialSession(owner, { bundleId, sessionId: resourceId(1) })).rejects.toMatchObject(failure("not-found"));
    await source.removeInitialMaterials(owner, { bundleId, materialId });
    await source.removeInitialMaterials(owner, { bundleId, materialId });
    await expect(source.resolveInitialMaterials(owner, { bundleId, materialId })).rejects.toMatchObject(failure("not-found"));
  });

  it("never overwrites a resource and removes it together with its upload file", async () => {
    const directory = await root();
    const source = await openBundleDirectory(directory);
    const materials = join(directory, owner, bundleId, "materials");
    await source.uploadInitialMaterials(owner, { bundleId, materialId }, files);
    await expect(readdir(materials)).resolves.toEqual([`${materialId}.json`]);
    await expect(source.uploadInitialMaterials(owner, { bundleId, materialId }, [
      { path: "/other.txt", mediaType: "text/plain", contentBase64: "SGk=" },
    ])).rejects.toMatchObject(failure("unavailable"));
    await expect(source.resolveInitialMaterials(owner, { bundleId, materialId })).resolves.toEqual(files);
    await writeFile(join(materials, `${materialId}.json.upload`), "partial");
    await source.removeInitialMaterials(owner, { bundleId, materialId });
    await expect(readdir(materials)).resolves.toEqual([]);
  });

  it("addresses resources only by canonical platform identities", async () => {
    const directory = await root();
    const source = await openBundleDirectory(directory);
    await source.uploadInitialMaterials(owner.toUpperCase(), { bundleId: bundleId.toUpperCase(), materialId }, files);
    await expect(source.resolveInitialMaterials(owner, { bundleId, materialId })).resolves.toEqual(files);
    await expect(source.uploadInitialMaterials("../other", { bundleId, materialId }, files))
      .rejects.toMatchObject(failure("invalid"));
    await expect(source.resolveInitialMaterials(owner, { bundleId: "project/assets", materialId }))
      .rejects.toMatchObject(failure("invalid"));
  });

  it("rejects malformed manifests, invalid Session content and files outside the Bundle root", async () => {
    const directory = await root();
    await put(directory, `materials/${materialId}.json`, '{"files":[{"path":1}]}');
    await put(directory, `sessions/${sessionId}.json`, '{"format":"jsonl","content":false}');
    const source = await openBundleDirectory(directory);
    await expect(source.resolveInitialMaterials(owner, { bundleId, materialId })).rejects.toMatchObject(failure("invalid"));
    await expect(source.resolveInitialSession(owner, { bundleId, sessionId })).rejects.toMatchObject(failure("invalid"));
    await expect(source.uploadInitialSession(owner, { bundleId, sessionId: resourceId(1) },
      { format: "jsonl", content: "not-json" })).rejects.toMatchObject(failure("invalid"));

    const outside = await root();
    const outsideFile = join(outside, "private.json");
    await writeFile(outsideFile, JSON.stringify({ files }));
    const manifest = join(directory, owner, bundleId, "materials", `${materialId}.json`);
    await rm(manifest);
    await symlink(outsideFile, manifest);
    await expect(source.resolveInitialMaterials(owner, { bundleId, materialId })).rejects.toMatchObject(failure("invalid"));
  });

  it("does not follow a Bundle link into another user's directory", async () => {
    const directory = await root();
    const source = await openBundleDirectory(directory);
    const context = { format: "json" as const, content: JSON.stringify({ entries: [JSON.parse(userEntry("m1"))] }) };
    await source.uploadInitialMaterials(otherOwner, { bundleId, materialId }, files);
    await source.uploadInitialSession(otherOwner, { bundleId, sessionId }, context);
    await mkdir(join(directory, owner));
    await symlink(join(directory, otherOwner, bundleId), join(directory, owner, bundleId), "dir");

    await expect(source.resolveInitialMaterials(owner, { bundleId, materialId })).rejects.toMatchObject(failure("invalid"));
    await expect(source.resolveInitialSession(owner, { bundleId, sessionId })).rejects.toMatchObject(failure("invalid"));
    await expect(source.uploadInitialMaterials(owner, { bundleId, materialId: resourceId(1) }, files))
      .rejects.toMatchObject(failure("invalid"));
    await expect(source.uploadInitialSession(owner, { bundleId, sessionId: resourceId(1) }, context))
      .rejects.toMatchObject(failure("invalid"));
    await expect(source.resolveInitialMaterials(otherOwner, { bundleId, materialId })).resolves.toEqual(files);
    await expect(source.resolveInitialMaterials(otherOwner, { bundleId, materialId: resourceId(1) }))
      .rejects.toMatchObject(failure("not-found"));
    await expect(source.resolveInitialSession(otherOwner, { bundleId, sessionId: resourceId(1) })).rejects.toMatchObject(failure("not-found"));
  });

  it("applies the SP material file contract when uploading and when reading an existing manifest", async () => {
    const directory = await root();
    const source = await openBundleDirectory(directory);
    const invalid = [
      [],
      [{ path: "/../secret.txt", mediaType: "text/plain", contentBase64: "SGk=" }],
      [{ path: "/brief.txt", mediaType: "text/plain", contentBase64: "not base64" }],
      [{ path: "/brief.txt", mediaType: " ", contentBase64: "SGk=" }],
      [...files, ...files],
    ].map((value) => [value, "invalid"] as const);
    const tooMany = Array.from({ length: 501 }, (_, index) => ({ path: `/${index}.txt`, mediaType: "text/plain", contentBase64: "SGk=" }));
    for (const [index, [value, reason]] of [...invalid, [tooMany, "too-large"] as const].entries()) {
      await expect(source.uploadInitialMaterials(owner, { bundleId, materialId: resourceId(index) }, value))
        .rejects.toMatchObject(failure(reason));
      await put(directory, `materials/${resourceId(index)}.json`, JSON.stringify({ files: value }));
      await expect(source.resolveInitialMaterials(owner, { bundleId, materialId: resourceId(index) }))
        .rejects.toMatchObject(failure(reason));
    }
  });

  it("rejects duplicate JSON keys in Session content when uploading and when reading", async () => {
    const directory = await root();
    const source = await openBundleDirectory(directory);
    const duplicate = { format: "jsonl" as const, content: `{"id":"m1","id":"m2","message":{"role":"user"},"createdAt":1}` };
    await expect(source.uploadInitialSession(owner, { bundleId, sessionId }, duplicate))
      .rejects.toMatchObject({ ...failure("invalid"), details: [{ path: "content:1" }] });
    await put(directory, `sessions/${sessionId}.json`, JSON.stringify(duplicate));
    await expect(source.resolveInitialSession(owner, { bundleId, sessionId }))
      .rejects.toMatchObject({ ...failure("invalid"), details: [{ path: "content:1" }] });
  });

  it("requires an absolute directory at startup", async () => {
    await expect(openBundleDirectory("relative/bundles")).rejects.toThrow(/absolute path/u);
  });
});
