import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { importOriginSchema } from "../config/agent-imports.js";
import type { Fetch } from "../sp/http.js";
import { IMPORT_LIMITS, uuid, type ExportFile, type FrozenFile } from "./model.js";
import { ImportConflictError, ImportDependencyError } from "./errors.js";

/** Exact deployment-owned public CDN origins. No suffix matching, wildcards or client-supplied hosts. */
export const IMPORT_CDN_ORIGINS = ["https://cdn.springbrand.ai"] as const;
export const SOURCE_IMPORT_CDN_ORIGINS = [
  "https://creation-file-dev.springbrand.ai", "https://devworkspace.springbrand.ai",
] as const;
export const TARGET_IMPORT_CDN_ORIGINS = [
  "https://creation-file-eval.springbrand.ai", "https://evalworkspace.springbrand.ai",
] as const;
// SP skillFile.path/archive paths have a 240-character budget. URI encoding and owner/version prefixes are separate.
const DOWNLOAD_PATH_LIMITS = { encoded: 4096, decoded: 1024, segment: 255, url: 8192 } as const;
const hashPattern = /^[0-9a-f]{64}$/u;
export function safeImportPath(value: string): string {
  // Manifest and ZIP paths are literal, not URI-encoded.
  if (!value || value.length > 240 || /^[\/\\]/u.test(value) || /[\\\u0000-\u001f\u007f]/u.test(value)
    || /^[a-z]:/iu.test(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ImportConflictError("Unsafe import file path");
  }
  return value;
}
function downloadPath(value: string, url: URL): string {
  // Inspect the original path: URL() would erase literal/percent-encoded dot segments before validation.
  const raw = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/iu.exec(value)?.[1] ?? "";
  if (value !== value.trim() || /[\\\u0000-\u001f\u007f]/u.test(value) || value.length > DOWNLOAD_PATH_LIMITS.url
    || !raw.startsWith("/") || url.pathname.length > DOWNLOAD_PATH_LIMITS.encoded) throw new ImportConflictError("Unsafe import download path");
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { throw new ImportConflictError("Invalid import download path"); }
  if (decoded.length > DOWNLOAD_PATH_LIMITS.decoded) throw new ImportConflictError("Import download path exceeds its budget");
  for (const segment of raw.slice(1).split("/")) {
    const part = decodeURIComponent(segment);
    if (!part || part === "." || part === ".." || part.length > DOWNLOAD_PATH_LIMITS.segment
      || /[\/\\\u0000-\u001f\u007f]/u.test(part) || /^[a-z]:/iu.test(part)
      || /%(?:2e|2f|5c|00|0[0-9a-f]|1[0-9a-f]|7f)/iu.test(part)) throw new ImportConflictError("Unsafe import download segment");
  }
  return decoded;
}
function notExpired(expiresAt: string): void {
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
    throw new ImportConflictError("Import preview has expired; check again");
  }
}
function bytesHash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function checkSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > IMPORT_LIMITS.fileBytes) throw new ImportConflictError("Import file exceeds byte limit");
}
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new ImportConflictError("Unsafe import staging directory");
  }
  if (process.getuid && stat.uid !== process.getuid()) throw new ImportConflictError("Import staging must be owned by this process user");
  await chmod(directory, 0o700);
}
export interface ImportStaging {
  write(taskId: string, file: ExportFile, body: ReadableStream<Uint8Array>, expiresAt: string,
    onBytes?: (bytes: number) => void): Promise<FrozenFile>;
  read(taskId: string, file: FrozenFile, expiresAt: string): Promise<Uint8Array>;
  /** Verify a staged file without creating directories, rewriting expiry or returning its bytes. */
  verify(taskId: string, file: FrozenFile, expiresAt: string): Promise<void>;
  zip(taskId: string, files: readonly FrozenFile[], expiresAt: string): Promise<Uint8Array>;
  prune(): Promise<void>;
}
/** Separate private roots share the same bounded staging implementation, never the same upload references. */
export async function openImportStaging(bundleDirectory: string,
  namespace: "imports" | "management-uploads" = "imports"): Promise<ImportStaging> {
  const base = await realpath(bundleDirectory);
  const root = path.join(base, namespace);
  await privateDirectory(root);
  async function directory(taskId: string, expiresAt: string): Promise<string> {
    notExpired(expiresAt);
    const dir = path.join(root, uuid.parse(taskId));
    await privateDirectory(dir);
    const expiry = await open(path.join(dir, "expires"), constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await expiry.writeFile(expiresAt); } finally { await expiry.close(); }
    return dir;
  }
  async function capacity(): Promise<number> {
    let total = 0;
    const entries = await readdir(root);
    if (entries.length > 10_000) throw new ImportConflictError("Import staging task limit reached");
    for (const name of entries) {
      if (!uuid.safeParse(name).success) continue;
      const dir = path.join(root, name);
      if (!(await lstat(dir)).isDirectory() || (await lstat(dir)).isSymbolicLink()) continue;
      const files = await readdir(dir);
      if (files.length > IMPORT_LIMITS.files + 100) throw new ImportConflictError("Import staging file limit reached");
      for (const file of files) total += (await lstat(path.join(dir, file))).size;
    }
    return total;
  }
  const store: ImportStaging = {
    async write(taskId, file, body, expiresAt, onBytes) {
      safeImportPath(file.path);
      checkSize(file.size);
      if (await capacity() + file.size > IMPORT_LIMITS.stagingBytes) {
        await body.cancel();
        throw new ImportConflictError("Import staging capacity reached");
      }
      const dir = await directory(taskId, expiresAt);
      const temp = path.join(dir, `${crypto.randomUUID()}.part`);
      const output = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const hash = createHash("sha256");
      const reader = body.getReader();
      let total = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          onBytes?.(next.value.byteLength);
          if (total > file.size || total > IMPORT_LIMITS.fileBytes) throw new ImportConflictError("Import file exceeds declared size");
          hash.update(next.value);
          await output.writeFile(next.value);
        }
        if (total !== file.size) throw new ImportConflictError("Import file size mismatch");
        const sha256 = hash.digest("hex");
        await output.close();
        await rename(temp, path.join(dir, sha256));
        return { ...file, sha256 };
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
        await output.close().catch(() => {});
        await rm(temp, { force: true });
      }
    },
    async read(taskId, file, expiresAt) {
      safeImportPath(file.path);
      checkSize(file.size);
      if (!hashPattern.test(file.sha256)) throw new ImportConflictError("Invalid staged file hash");
      const dir = await directory(taskId, expiresAt);
      const input = await open(path.join(dir, file.sha256), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await input.stat();
        if (!stat.isFile() || stat.size !== file.size) throw new ImportConflictError("Staged file size mismatch");
        const bytes = await input.readFile();
        if (bytesHash(bytes) !== file.sha256) throw new ImportConflictError("Staged file hash mismatch");
        return new Uint8Array(bytes);
      } finally { await input.close(); }
    },
    async verify(taskId, file, expiresAt) {
      safeImportPath(file.path);
      checkSize(file.size);
      if (!hashPattern.test(file.sha256)) throw new ImportConflictError("Invalid staged file hash");
      notExpired(expiresAt);
      const dir = path.join(root, uuid.parse(taskId));
      const directoryStat = await lstat(dir); // no mkdir, chmod or expiry-file write on a GET
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await realpath(dir) !== dir
        || (process.getuid && directoryStat.uid !== process.getuid()) || (directoryStat.mode & 0o077) !== 0) {
        throw new ImportConflictError("Unsafe import staging directory");
      }
      const input = await open(path.join(dir, file.sha256), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await input.stat();
        if (!stat.isFile() || stat.size !== file.size) throw new ImportConflictError("Staged file size mismatch");
        const hash = createHash("sha256");
        const chunk = Buffer.allocUnsafe(64 * 1024);
        for (let at = 0; at < file.size;) {
          const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.byteLength, file.size - at), at);
          if (bytesRead === 0) throw new ImportConflictError("Staged file ended early");
          hash.update(chunk.subarray(0, bytesRead));
          at += bytesRead;
        }
        if ((await input.stat()).size !== file.size || hash.digest("hex") !== file.sha256) {
          throw new ImportConflictError("Staged file hash mismatch");
        }
      } finally { await input.close(); }
    },
    async zip(taskId, files, expiresAt) {
      if (files.length === 0 || files.length > IMPORT_LIMITS.files || !files.some((file) => file.path === "SKILL.md")
        || new Set(files.map((file) => file.path)).size !== files.length
        || files.reduce((sum, file) => sum + file.size, 0) > IMPORT_LIMITS.totalBytes) throw new ImportConflictError("Invalid Skill package");
      const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 });
      try {
        for (const file of files) await zip.add(safeImportPath(file.path), new Uint8ArrayReader(await store.read(taskId, file, expiresAt)),
          { lastModDate: new Date("2000-01-01T00:00:00Z") });
        return await zip.close();
      } catch (error) { await zip.close().catch(() => {}); throw error; }
    },
    async prune() {
      for (const name of await readdir(root)) {
        if (!uuid.safeParse(name).success) continue;
        const dir = path.join(root, name);
        const stat = await lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const expiry = await open(path.join(dir, "expires"), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
        if (!expiry) {
          if (stat.mtimeMs + IMPORT_LIMITS.ttlMs <= Date.now()) await rm(dir, { recursive: true });
          continue;
        }
        try {
          if ((await expiry.stat()).size > 64) continue;
          const expiresAt = await expiry.readFile("utf8");
          if (Date.parse(expiresAt) <= Date.now()) await rm(dir, { recursive: true });
        } finally { await expiry.close(); }
      }
    },
  };
  return store;
}

export function createImportDownloads(input: { origin: string; purpose: "source" | "target"; fetch?: Fetch }) {
  const origin = importOriginSchema.parse(input.origin);
  const ownCdns = input.purpose === "source" ? SOURCE_IMPORT_CDN_ORIGINS : TARGET_IMPORT_CDN_ORIGINS;
  const foreignCdns: readonly string[] = input.purpose === "source" ? TARGET_IMPORT_CDN_ORIGINS : SOURCE_IMPORT_CDN_ORIGINS;
  const allowed = new Set<string>([origin, ...IMPORT_CDN_ORIGINS, ...ownCdns].filter((value) => !foreignCdns.includes(value)));
  let bytesRead = 0;
  let filesRead = 0;
  function validateUrl(value: string): string {
    const url = new URL(value);
    const decoded = downloadPath(value, url);
    if (!allowed.has(url.origin) || url.username || url.password || url.hash
      || (url.protocol !== "https:" && url.origin !== origin)
      || /^\/api(?:\/|$)/u.test(decoded.toLowerCase())) throw new ImportConflictError("Untrusted import download address");
    return url.href;
  }
  function countBytes(bytes: number): void {
    bytesRead += bytes;
    if (bytesRead > IMPORT_LIMITS.totalBytes) throw new ImportConflictError("Import total byte limit exceeded");
  }
  async function begin(file: ExportFile): Promise<Response> {
    checkSize(file.size);
    safeImportPath(file.path);
    const url = validateUrl(file.url);
    if (++filesRead > IMPORT_LIMITS.files || bytesRead + file.size > IMPORT_LIMITS.totalBytes) {
      throw new ImportConflictError("Import exceeds total files/bytes limit");
    }
    let response: Response;
    try {
      response = await (input.fetch ?? globalThis.fetch)(url, {
        method: "GET", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(60_000),
        headers: { "Accept-Encoding": "identity" },
      });
    } catch (cause) { throw new ImportDependencyError("Import file download is unavailable", cause); }
    if (!response.ok || response.redirected || !response.body || (response.url && response.url !== url)) {
      await response.body?.cancel();
      throw new ImportDependencyError("Import file download did not return the exact authorized address");
    }
    return response;
  }
  return {
    get bytesRead() { return bytesRead; },
    validateUrl,
    async freeze(store: ImportStaging, taskId: string, file: ExportFile, expiresAt: string): Promise<FrozenFile> {
      const response = await begin(file);
      try {
        return await store.write(taskId, file, response.body!, expiresAt, countBytes);
      } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    },
    /** Receipt reconciliation may verify target bytes after staged source bytes expired; it never starts a new import. */
    async hash(file: ExportFile): Promise<FrozenFile> {
      const response = await begin(file);
      const reader = response.body!.getReader();
      const hash = createHash("sha256");
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          countBytes(next.value.byteLength);
          size += next.value.byteLength;
          if (size > file.size) throw new ImportConflictError("Downloaded file exceeds declared size");
          hash.update(next.value);
        }
        if (size !== file.size) throw new ImportConflictError("Downloaded file size mismatch");
        return { ...file, sha256: hash.digest("hex") };
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
    },
  };
}
