import { link, lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { parseStrictJson, platformIdSchema, type InitialMaterialsRef, type InitialSessionRef } from "@eval-platform/eval-dataset";
import { validateMaterialFiles, validateSessionContent, type MaterialFile, type SessionContent } from "./bundle-content.js";
import { BundleFileError } from "./bundle-errors.js";

type ResourceLocation = { readonly path: string; readonly ownerDirectory: string };

export interface BundleDirectory {
  resolveInitialMaterials(ownerUserId: string, reference: InitialMaterialsRef): Promise<readonly MaterialFile[]>;
  resolveInitialSession(ownerUserId: string, reference: InitialSessionRef): Promise<SessionContent | undefined>;
  /** Validate and store one Material's files; resolves to their total decoded bytes. */
  uploadInitialMaterials(ownerUserId: string, reference: InitialMaterialsRef,
    files: readonly MaterialFile[]): Promise<number>;
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
    resourceId: string): ResourceLocation => {
    const ownerDirectory = join(root, platformId(ownerUserId, "Bundle owner"));
    return {
      ownerDirectory,
      path: join(ownerDirectory, platformId(bundleId, "Bundle"), kind, `${platformId(resourceId, "resource")}.json`),
    };
  };
  const materialsLocation = (ownerUserId: string, reference: InitialMaterialsRef): ResourceLocation =>
    resourceLocation(ownerUserId, reference.bundleId, "materials", reference.materialId);
  const sessionLocation = (ownerUserId: string, reference: InitialSessionRef): ResourceLocation =>
    resourceLocation(ownerUserId, reference.bundleId, "sessions", reference.sessionId);

  async function readResource(location: ResourceLocation): Promise<unknown> {
    let resolved: string;
    try {
      resolved = await realpath(location.path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw unavailable(error);
    }
    if (!insideRoot(location.ownerDirectory, resolved)) {
      throw new BundleFileError("invalid", "Initial Bundle resource escapes its owner directory");
    }
    let bytes: Uint8Array;
    try {
      if (!(await stat(resolved)).isFile()) throw new BundleFileError("invalid", "Initial Bundle resource is not a file");
      bytes = await readFile(resolved);
    } catch (error) {
      if (error instanceof BundleFileError) throw error;
      throw unavailable(error);
    }
    try {
      return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (cause) {
      throw new BundleFileError("invalid", "Initial Bundle resource is not valid JSON", { cause });
    }
  }

  /** Links a fully written sibling into place so a resource is never overwritten or seen half-written. */
  async function writeResource(location: ResourceLocation, value: unknown): Promise<void> {
    const parent = dirname(location.path);
    const temporary = uploadPath(location);
    try {
      await ensureDirectory(location.ownerDirectory);
      await ensureDirectory(dirname(parent));
      await ensureDirectory(parent);
      if (!insideRoot(location.ownerDirectory, await realpath(parent))) {
        throw new BundleFileError("invalid", "Initial Bundle resource escapes its owner directory");
      }
      await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        await link(temporary, location.path);
      } finally {
        await unlink(temporary);
      }
    } catch (error) {
      if (error instanceof BundleFileError) throw error;
      throw unavailable(error);
    }
  }

  async function removeResource(location: ResourceLocation): Promise<void> {
    for (const path of [location.path, uploadPath(location)]) {
      try {
        await unlink(path);
      } catch (error) {
        if (!isMissing(error)) throw unavailable(error);
      }
    }
  }

  return {
    async uploadInitialMaterials(ownerUserId, reference, input) {
      const { files, byteSize } = validateMaterialFiles(input);
      await writeResource(materialsLocation(ownerUserId, reference), { files });
      return byteSize;
    },
    async uploadInitialSession(ownerUserId, reference, context) {
      await writeResource(sessionLocation(ownerUserId, reference), validateSessionContent(context));
    },
    async removeInitialMaterials(ownerUserId, reference) {
      await removeResource(materialsLocation(ownerUserId, reference));
    },
    async removeInitialSession(ownerUserId, reference) {
      await removeResource(sessionLocation(ownerUserId, reference));
    },
    async resolveInitialMaterials(ownerUserId, reference) {
      const manifest = await readResource(materialsLocation(ownerUserId, reference));
      if (manifest === undefined) throw new BundleFileError("not-found", "Initial material is missing from its Bundle");
      if (!isRecord(manifest) || Object.keys(manifest).length !== 1 || !("files" in manifest)) {
        throw new BundleFileError("invalid", "Initial material manifest must contain only files");
      }
      return validateMaterialFiles(manifest.files).files;
    },
    async resolveInitialSession(ownerUserId, reference) {
      const context = await readResource(sessionLocation(ownerUserId, reference));
      return context === undefined ? undefined : validateSessionContent(context);
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
    throw new BundleFileError("invalid", "Initial Bundle directory path must be a directory, not a file or symbolic link");
  }
}

function platformId(value: string, name: string): string {
  const parsed = platformIdSchema.safeParse(value);
  if (!parsed.success) throw new BundleFileError("invalid", `Invalid ${name} identity`, { cause: parsed.error });
  return parsed.data;
}

function uploadPath(location: ResourceLocation): string {
  return `${location.path}.upload`;
}

function unavailable(cause: unknown): BundleFileError {
  return new BundleFileError("unavailable", "Initial Bundle resource is unavailable", { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function insideRoot(root: string, path: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
