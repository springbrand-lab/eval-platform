import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter, type ZipWriterAddDataOptions } from "@zip.js/zip.js";
import { EVAL_INITIAL_FILE_MAX_BYTES } from "@springbrand/eval-harness";
import { describe, expect, it } from "vitest";
import { ZIP_ARCHIVE_BYTES, ZIP_ENTRIES, BUNDLE_ERROR_DETAILS, ZIP_EXPANDED_BYTES, ZIP_RESOURCES } from "../limits.js";
import { readMaterialZip, readSessionZip } from "./bundle-zip.js";

type ZipEntry = readonly [name: string, content?: string | Uint8Array, options?: ZipWriterAddDataOptions];

const entry = (id: string, role = "user") => JSON.stringify({ id, message: { role, content: "Hi" }, createdAt: 1 });
const sessionJson = (...ids: string[]) => JSON.stringify({ entries: ids.map((id) => JSON.parse(entry(id))) });

/** Entries named with a trailing slash are directories; the rest are files. */
async function zip(...entries: readonly ZipEntry[]): Promise<Buffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, content = "", options] of entries) {
    if (name.endsWith("/")) await writer.add(name, undefined, { ...options, directory: true });
    else await writer.add(name, new Uint8ArrayReader(typeof content === "string" ? new TextEncoder().encode(content) : content), options);
  }
  return Buffer.from(await writer.close());
}

/** Rewrite equal-length bytes in every header, for archives a ZIP writer refuses to produce. */
function patch(bytes: Buffer, from: string, to: string): Buffer {
  const patched = Buffer.from(bytes);
  for (let at = patched.indexOf(from); at >= 0; at = patched.indexOf(from, at + 1)) patched.write(to, at);
  return patched;
}

const invalid = (...details: readonly { path: string; errMsg?: unknown }[]) => ({
  name: "BundleFileError",
  reason: "invalid",
  details: details.map(({ path, errMsg = expect.any(String) }) => ({ path, errMsg })),
});
const tooLarge = (path = "zip") => ({ name: "BundleFileError", reason: "too-large", details: [{ path, errMsg: expect.any(String) }] });

describe("Session ZIP", () => {
  it("reads each root JSON or JSONL file as one Session with its original content", async () => {
    const jsonl = `${entry("m1")}\r\n\n${entry("m2", "assistant")}\n`;
    await expect(readSessionZip(await zip(["a.json", sessionJson("m1")], ["b.jsonl", jsonl]))).resolves.toEqual([
      { source: "a.json", content: { format: "json", content: sessionJson("m1") } },
      { source: "b.jsonl", content: { format: "jsonl", content: jsonl } },
    ]);
  });

  it("rejects directories, nested paths, other extensions and platform metadata files without exception", async () => {
    const failure = await readSessionZip(await zip(
      ["ok.json", sessionJson("m1")],
      ["nested/"],
      ["nested/a.json", sessionJson("m1")],
      ["notes.txt", "x"],
      ["upper.JSON", sessionJson("m1")],
      ["__MACOSX/._ok.json", "x"],
      [".DS_Store", "x"],
    )).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "BundleFileError", reason: "invalid" });
    expect((failure as { details: { path: string }[] }).details.map(({ path }) => path).sort()).toEqual(
      [".DS_Store", "__MACOSX/._ok.json", "nested", "nested/a.json", "notes.txt", "upper.JSON"].sort(),
    );
  });

  it("rejects the whole archive for one invalid file, naming its entry and JSONL line", async () => {
    await expect(readSessionZip(await zip(
      ["good.jsonl", entry("m1")],
      ["bad.jsonl", `${entry("m1")}\n{"id":\n\n{"id":"m3","id":"m4"}`],
      ["dup.json", `{"entries":[],"entries":[${entry("m1")}]}`],
      ["empty.json"],
      ["latin1.json", new Uint8Array([0xff])],
      ["sp.json", JSON.stringify({ entries: [JSON.parse(entry("m1", "assistant"))] })],
    ))).rejects.toMatchObject(invalid(
      { path: "bad.jsonl:2", errMsg: expect.stringMatching(/^Invalid JSON/u) },
      { path: "bad.jsonl:4", errMsg: expect.stringMatching(/Duplicate JSON field "id"/u) },
      { path: "dup.json", errMsg: expect.stringMatching(/Duplicate JSON field "entries"/u) },
      { path: "empty.json" },
      { path: "latin1.json", errMsg: "Session file must be UTF-8 text" },
      { path: "sp.json" },
    ));
  });

  it("caps the reported entry errors", async () => {
    const entries = Array.from({ length: BUNDLE_ERROR_DETAILS + 20 }, (_, index): ZipEntry => [`${index}.txt`]);
    const failure = await readSessionZip(await zip(...entries)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason: "invalid" });
    expect((failure as { details: unknown[] }).details).toHaveLength(BUNDLE_ERROR_DETAILS);
  });

  it("counts every file in the archive against the resource limit", async () => {
    const entries = Array.from({ length: ZIP_RESOURCES + 1 }, (_, index): ZipEntry => [`${index}.txt`]);
    await expect(readSessionZip(await zip(...entries))).rejects.toMatchObject(tooLarge());
  });
});

describe("Material ZIP resource limit", () => {
  it("counts every top-level entry, including empty directories", async () => {
    const entries = Array.from({ length: ZIP_RESOURCES }, (_, index): ZipEntry => [`${index}/`]);
    await expect(readMaterialZip(await zip(["a.txt", "x"], ...entries))).rejects.toMatchObject(tooLarge());
  });
});

describe("Material ZIP", () => {
  it("groups root files and top-level directories into Materials with inner paths", async () => {
    await expect(readMaterialZip(await zip(
      ["brief.txt", "Hello"],
      ["docs/"],
      ["docs/a.md", "# A"],
      ["docs/sub/b.json", "{not json"],
      ["docs/raw", "x"],
    ))).resolves.toEqual([
      { source: "brief.txt", files: [{ path: "/brief.txt", mediaType: "text/plain", contentBase64: "SGVsbG8=" }] },
      { source: "docs", files: [
        { path: "/a.md", mediaType: "text/markdown", contentBase64: Buffer.from("# A").toString("base64") },
        { path: "/raw", mediaType: "application/octet-stream", contentBase64: "eA==" },
        { path: "/sub/b.json", mediaType: "application/json", contentBase64: Buffer.from("{not json").toString("base64") },
      ] },
    ]);
  });

  it("rejects a name that is both a file and a directory, and Material paths SP refuses", async () => {
    await expect(readMaterialZip(await zip(["a", "x"], ["a/b.txt", "y"], ["c.txt", "z"])))
      .rejects.toMatchObject(invalid({ path: "a", errMsg: "ZIP entry is both a file and a directory" }));
    await expect(readMaterialZip(await zip(["d/.git/config", "x"]))).rejects.toMatchObject(invalid({ path: "d/.git/config" }));
  });

  it("rejects resources whose top-level name is blank", async () => {
    const archive = patch(patch(await zip(["@", "x"], ["##/x.txt", "y"], ["ok.txt", "z"]), "@", " "), "##/", "  /");
    await expect(readMaterialZip(archive))
      .rejects.toMatchObject(invalid({ path: " ", errMsg: "ZIP resource name must be nonblank" }, { path: "  /x.txt" }));
  });

  it("reports the first archive violation of SP's strict-ZIP inspector under its entry path", async () => {
    await expect(readMaterialZip(patch(await zip(["aa/x.txt", "x"]), "aa/x", "../x")))
      .rejects.toMatchObject(invalid({ path: "../x.txt", errMsg: "../x.txt: Unsafe archive path" }));
    await expect(readMaterialZip(await zip(["ok.txt", "x"], ["link", "ok.txt", { unixMode: 0o120777, msDosCompatible: false }])))
      .rejects.toMatchObject(invalid({ path: "link", errMsg: "link: Archive entry must be a regular file" }));
    await expect(readMaterialZip(Buffer.from("not a zip archive"))).rejects.toMatchObject(invalid({ path: "zip" }));
  });

  it("rejects empty archives and top-level directories without files", async () => {
    await expect(readMaterialZip(await zip())).rejects.toMatchObject(invalid({ path: "zip" }));
    await expect(readMaterialZip(await zip(["a.txt", "x"], ["d/"], ["d/e/"])))
      .rejects.toMatchObject(invalid({ path: "d", errMsg: "A Material directory must contain at least one file" }));
  });

  it("rejects archives past their size limits before inflating them", async () => {
    await expect(readMaterialZip(new Uint8Array(ZIP_ARCHIVE_BYTES + 1))).rejects.toMatchObject(tooLarge());
    await expect(readMaterialZip(await zip(["big.bin", new Uint8Array(EVAL_INITIAL_FILE_MAX_BYTES + 1)])))
      .rejects.toMatchObject(tooLarge("big.bin"));
    await expect(readMaterialZip(await zip(...Array.from({ length: ZIP_ENTRIES + 1 }, (_, index): ZipEntry => [`${index}.txt`]))))
      .rejects.toMatchObject(tooLarge());
    const bomb = await zip(...Array.from({ length: 21 }, (_, index): ZipEntry => [`${index}.bin`, new Uint8Array(ZIP_EXPANDED_BYTES / 20)]));
    expect(bomb.byteLength).toBeLessThan(1_000_000);
    await expect(readMaterialZip(bomb)).rejects.toMatchObject(tooLarge());
  });
});
