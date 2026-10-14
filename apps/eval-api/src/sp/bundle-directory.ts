import { link, lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import type { InitialMaterialsRef, InitialSessionRef } from "@eval-platform/eval-dataset";
import { SpHarnessError, type SpHarnessOptions } from "./harness.js";
import { parseStrictJson } from "../strict-json.js";

const MAX_MATERIAL_MANIFEST_BYTES = 27_000_000;
const MAX_SESSION_FILE_BYTES = 2_500_000;
const MAX_SESSION_CONTENT_LENGTH = 2_000_000;
const MAX_MATERIAL_BYTES = 20_000_000;
const MAX_SINGLE_MATERIAL_BYTES = 5_000_000;
const OWNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type MaterialFile = { readonly path: string; readonly mediaType: string; readonly contentBase64: string };
export type SessionContent = { readonly format: "json" | "jsonl"; readonly content: string };
type ResourceLocation = { readonly path: string; readonly ownerDirectory: string };

export interface BundleDirectory {
  resolveInitialMaterials: NonNullable<SpHarnessOptions["resolveInitialMaterials"]>;
  resolveInitialSession: NonNullable<SpHarnessOptions["resolveInitialSession"]>;
  uploadInitialMaterials(ownerUserId: string, reference: InitialMaterialsRef,
    files: readonly MaterialFile[]): Promise<void>;
  uploadInitialSession(ownerUserId: string, reference: InitialSessionRef,
    context: SessionContent): Promise<void>;
  removeInitialMaterials(ownerUserId: string, reference: InitialMaterialsRef): Promise<void>;
  removeInitialSession(ownerUserId: string, reference: InitialSessionRef): Promise<void>;
}

/** Open the deployment-owned Bundle directory shared by uploads and the Run Worker. */
export async function openBundleDirectory(directory: string): Promise<BundleDirectory> {
  if (!isAbsolute(directory)) throw new Error("EVAL_BUNDLE_DIR must be an absolute path");
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) throw new Error("EVAL_BUNDLE_DIR must be a directory");

  const resourceLocation = (ownerUserId: string, bundleId: string, kind: "materials" | "sessions",
    resourceId: string, extension: "json" | "jsonl"): ResourceLocation => {
    if (!OWNER_ID.test(ownerUserId)) throw new SpHarnessError("Invalid Bundle owner identity", false);
    const ownerDirectory = join(root, ownerUserId.toLowerCase());
    return {
      ownerDirectory,
      path: join(ownerDirectory, encodeId(bundleId), kind, `${encodeId(resourceId)}.${extension}`),
    };
  };

  async function readResource(location: ResourceLocation, maxBytes: number): Promise<Uint8Array | undefined> {
    let resolved: string;
    try {
      resolved = await realpath(location.path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new SpHarnessError("Initial Bundle resource could not be read", true);
    }
    if (!insideRoot(location.ownerDirectory, resolved)) {
      throw new SpHarnessError("Initial Bundle resource escapes its owner directory", false);
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

  async function writeResource(location: ResourceLocation, bytes: Uint8Array, maxBytes: number): Promise<void> {
    if (bytes.byteLength > maxBytes) throw new SpHarnessError("Initial Bundle resource is too large", false);
    const parent = dirname(location.path);
    await ensureDirectory(location.ownerDirectory);
    await ensureDirectory(dirname(parent));
    await ensureDirectory(parent);
    const resolvedParent = await realpath(parent);
    if (!insideRoot(location.ownerDirectory, resolvedParent)) {
      throw new SpHarnessError("Initial Bundle resource escapes its owner directory", false);
    }
    const temporary = join(parent, `.${crypto.randomUUID()}.upload`);
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
      try {
        await link(temporary, location.path);
      } catch (error) {
        if (!isExisting(error)) throw error;
        const existing = await readResource(location, maxBytes);
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
      const validated = validateMaterialFiles(files);
      const bytes = Buffer.from(JSON.stringify({ files: validated }), "utf8");
      await writeResource(resourceLocation(ownerUserId, reference.bundleId, "materials",
        reference.materialId, "json"), bytes, MAX_MATERIAL_MANIFEST_BYTES);
    },
    async uploadInitialSession(ownerUserId, reference, context) {
      const validated = validateSessionContent(context);
      const bytes = Buffer.from(JSON.stringify(validated), "utf8");
      await writeResource(resourceLocation(ownerUserId, reference.bundleId, "sessions",
        reference.sessionId, "json"), bytes, MAX_SESSION_FILE_BYTES);
    },
    async removeInitialMaterials(ownerUserId, reference) {
      const location = resourceLocation(ownerUserId, reference.bundleId, "materials", reference.materialId, "json");
      try { await unlink(location.path); }
      catch (error) { if (!isMissing(error)) throw error; }
    },
    async removeInitialSession(ownerUserId, reference) {
      const location = resourceLocation(ownerUserId, reference.bundleId, "sessions", reference.sessionId, "json");
      try { await unlink(location.path); }
      catch (error) { if (!isMissing(error)) throw error; }
    },
    async resolveInitialMaterials(ownerUserId: string, reference: InitialMaterialsRef) {
      const bytes = await readResource(resourceLocation(ownerUserId, reference.bundleId, "materials",
        reference.materialId, "json"), MAX_MATERIAL_MANIFEST_BYTES);
      if (!bytes) throw new SpHarnessError("Initial material is missing from its Bundle", false);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new SpHarnessError("Initial material manifest is invalid JSON", false);
      }
      if (!isRecord(parsed) || Object.keys(parsed).length !== 1) {
        throw new SpHarnessError("Initial material manifest must contain files", false);
      }
      return validateMaterialFiles(parsed.files);
    },
    async resolveInitialSession(ownerUserId: string, reference: InitialSessionRef) {
      const bytes = await readResource(resourceLocation(ownerUserId, reference.bundleId, "sessions",
        reference.sessionId, "json"), MAX_SESSION_FILE_BYTES);
      if (!bytes) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new SpHarnessError("Initial Session content is invalid", false);
      }
      return validateSessionContent(parsed);
    },
  };
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (!isExisting(error)) throw error;
  }
  if (!(await lstat(path)).isDirectory()) {
    throw new SpHarnessError("Initial Bundle directory must not be a symbolic link", false);
  }
}

function validateMaterialFiles(value: unknown): readonly MaterialFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new SpHarnessError("Initial materials must contain between 1 and 500 files", false);
  }
  let total = 0;
  const paths = new Set<string>();
  for (const file of value) {
    if (!isRecord(file) ||
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
  return value as readonly MaterialFile[];
}

function validateSessionContent(value: unknown): SessionContent {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "format" && key !== "content") ||
    (value.format !== "json" && value.format !== "jsonl") ||
    typeof value.content !== "string" || !value.content.trim() ||
    value.content.length > MAX_SESSION_CONTENT_LENGTH) {
    throw new SpHarnessError("Initial Session content is invalid or too large", false);
  }
  let snapshot: unknown;
  try {
    snapshot = value.format === "json"
      ? parseStrictJson(value.content)
      : { entries: value.content.split(/\r?\n/u).filter((line) => line.trim()).map(parseStrictJson) };
  } catch {
    throw new SpHarnessError("Initial Session content is not valid JSON or JSONL", false);
  }
  if (!isRecord(snapshot) || !Array.isArray(snapshot.entries) || snapshot.entries.length > 10_000) {
    throw new SpHarnessError("Initial Session must contain canonical entries", false);
  }
  const seen = new Set<string>();
  for (const [index, entry] of snapshot.entries.entries()) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id || seen.has(entry.id) ||
      typeof entry.createdAt !== "number" || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0 ||
      !isRecord(entry.message) || typeof entry.message.role !== "string" ||
      !["user", "assistant", "toolResult"].includes(entry.message.role) ||
      (index === 0 && entry.message.role !== "user")) {
      throw new SpHarnessError("Initial Session contains invalid canonical entries", false);
    }
    seen.add(entry.id);
  }
  return { format: value.format, content: value.content };
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
