import { link, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import type { InitialMaterialsRef, InitialSessionRef } from "@eval-platform/eval-dataset";
import { SpHarnessError, type SpHarnessOptions } from "./harness.js";

const MAX_MATERIAL_MANIFEST_BYTES = 27_000_000;
const MAX_SESSION_FILE_BYTES = 2_500_000;
const MAX_SESSION_CONTENT_LENGTH = 2_000_000;
const MAX_MATERIAL_BYTES = 20_000_000;
const MAX_SINGLE_MATERIAL_BYTES = 5_000_000;
const OWNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type MaterialFile = { readonly path: string; readonly mediaType: string; readonly contentBase64: string };
type SessionContent = { readonly format: "json" | "jsonl"; readonly content: string };

export interface BundleDirectory {
  resolveInitialMaterials: NonNullable<SpHarnessOptions["resolveInitialMaterials"]>;
  resolveInitialSession: NonNullable<SpHarnessOptions["resolveInitialSession"]>;
  uploadInitialMaterials(ownerUserId: string, reference: InitialMaterialsRef,
    files: readonly MaterialFile[]): Promise<void>;
  uploadInitialSession(ownerUserId: string, reference: InitialSessionRef,
    context: SessionContent): Promise<void>;
}

/** Open the deployment-owned Bundle directory shared by uploads and the Run Worker. */
export async function openBundleDirectory(directory: string): Promise<BundleDirectory> {
  if (!isAbsolute(directory)) throw new Error("EVAL_BUNDLE_DIR must be an absolute path");
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) throw new Error("EVAL_BUNDLE_DIR must be a directory");

  const resourcePath = (ownerUserId: string, bundleId: string, kind: "materials" | "sessions",
    resourceId: string, extension: "json" | "jsonl"): string => {
    if (!OWNER_ID.test(ownerUserId)) throw new SpHarnessError("Invalid Bundle owner identity", false);
    return join(root, ownerUserId.toLowerCase(), encodeId(bundleId), kind, `${encodeId(resourceId)}.${extension}`);
  };

  async function readResource(path: string, maxBytes: number): Promise<Uint8Array | undefined> {
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new SpHarnessError("Initial Bundle resource could not be read", true);
    }
    if (!insideRoot(root, resolved)) {
      throw new SpHarnessError("Initial Bundle resource escapes the configured directory", false);
    }
    try {
      const info = await stat(resolved);
      if (!info.isFile() || info.size > maxBytes) {
        throw new SpHarnessError("Initial Bundle resource is not a bounded file", false);
      }
      const bytes = await readFile(resolved);
      if (bytes.byteLength > maxBytes) {
        throw new SpHarnessError("Initial Bundle resource is too large", false);
      }
      return bytes;
    } catch (error) {
      if (error instanceof SpHarnessError) throw error;
      throw new SpHarnessError("Initial Bundle resource could not be read", true);
    }
  }

  async function writeResource(path: string, bytes: Uint8Array, maxBytes: number): Promise<void> {
    if (bytes.byteLength > maxBytes) throw new SpHarnessError("Initial Bundle resource is too large", false);
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    const resolvedParent = await realpath(parent);
    if (!insideRoot(root, resolvedParent)) {
      throw new SpHarnessError("Initial Bundle resource escapes the configured directory", false);
    }
    const temporary = join(parent, `.${crypto.randomUUID()}.upload`);
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
      try {
        await link(temporary, path);
      } catch (error) {
        if (!isExisting(error)) throw error;
        const existing = await readResource(path, maxBytes);
        if (!existing || !Buffer.from(existing).equals(bytes)) {
          throw new SpHarnessError("Initial Bundle resource already has different content", false);
        }
      }
    } finally {
      await unlink(temporary);
    }
  }

  return {
    async uploadInitialMaterials(ownerUserId, reference, files) {
      if (!Array.isArray(files) || files.length > 500) {
        throw new SpHarnessError("Initial materials must contain at most 500 files", false);
      }
      let total = 0;
      const paths = new Set<string>();
      for (const file of files) {
        if (!file || typeof file !== "object" ||
          Object.keys(file).some((key) => key !== "path" && key !== "mediaType" && key !== "contentBase64") ||
          !validMaterialPath(file.path) || typeof file.mediaType !== "string" || !file.mediaType.trim() ||
          !canonicalBase64(file.contentBase64) || paths.has(file.path)) {
          throw new SpHarnessError("Initial material file is invalid or duplicated", false);
        }
        paths.add(file.path);
        const size = Buffer.from(file.contentBase64, "base64").byteLength;
        total += size;
        if (size > MAX_SINGLE_MATERIAL_BYTES || total > MAX_MATERIAL_BYTES) {
          throw new SpHarnessError("Initial materials are too large", false);
        }
      }
      const bytes = Buffer.from(JSON.stringify({ files }), "utf8");
      await writeResource(resourcePath(ownerUserId, reference.bundleId, "materials",
        reference.materialId, "json"), bytes, MAX_MATERIAL_MANIFEST_BYTES);
    },
    async uploadInitialSession(ownerUserId, reference, context) {
      if (!context || (context.format !== "json" && context.format !== "jsonl") ||
        typeof context.content !== "string" || !context.content.trim() ||
        context.content.length > MAX_SESSION_CONTENT_LENGTH) {
        throw new SpHarnessError("Initial Session content is invalid or too large", false);
      }
      try {
        if (context.format === "json") JSON.parse(context.content);
        else for (const line of context.content.split(/\r?\n/u).filter((line) => line.trim())) JSON.parse(line);
      } catch {
        throw new SpHarnessError("Initial Session content is not valid JSON or JSONL", false);
      }
      const bytes = Buffer.from(JSON.stringify(context), "utf8");
      await writeResource(resourcePath(ownerUserId, reference.bundleId, "sessions",
        reference.sessionId, "json"), bytes, MAX_SESSION_FILE_BYTES);
    },
    async resolveInitialMaterials(ownerUserId: string, reference: InitialMaterialsRef) {
      const bytes = await readResource(resourcePath(ownerUserId, reference.bundleId, "materials",
        reference.materialId, "json"), MAX_MATERIAL_MANIFEST_BYTES);
      if (!bytes) throw new SpHarnessError("Initial material is missing from its Bundle", false);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new SpHarnessError("Initial material manifest is invalid JSON", false);
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.files) || parsed.files.length > 500 ||
        parsed.files.some((file) => !isRecord(file) || typeof file.path !== "string" ||
          typeof file.mediaType !== "string" || typeof file.contentBase64 !== "string")) {
        throw new SpHarnessError("Initial material manifest must contain files", false);
      }
      return parsed.files.map((file) => ({
        path: file.path as string,
        mediaType: file.mediaType as string,
        contentBase64: file.contentBase64 as string,
      }));
    },
    async resolveInitialSession(ownerUserId: string, reference: InitialSessionRef) {
      const bytes = await readResource(resourcePath(ownerUserId, reference.bundleId, "sessions",
        reference.sessionId, "json"), MAX_SESSION_FILE_BYTES);
      if (!bytes) return undefined;
      try {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!isRecord(parsed) || (parsed.format !== "json" && parsed.format !== "jsonl") ||
          typeof parsed.content !== "string" || !parsed.content.trim() ||
          parsed.content.length > MAX_SESSION_CONTENT_LENGTH) throw new Error("invalid");
        return { format: parsed.format, content: parsed.content };
      } catch {
        throw new SpHarnessError("Initial Session content is invalid", false);
      }
    },
  };
}

function encodeId(id: string): string {
  try {
    return encodeURIComponent(id).replaceAll(".", "%2E");
  } catch {
    throw new SpHarnessError("Initial Bundle resource ID is invalid", false);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function insideRoot(root: string, path: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function isExisting(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function canonicalBase64(value: unknown): value is string {
  return typeof value === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function validMaterialPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/") && path.length > 1 &&
    path.split("/").slice(1).every((segment) => segment && segment !== "." &&
      segment !== ".." && segment !== ".git" && !segment.includes("\\") && !segment.includes("\0"));
}
