import { link, lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { platformIdSchema, type InitialMaterialsRef, type InitialSessionRef } from "@eval-platform/eval-dataset";
import {
  evalInitialContextSchema,
  evalInitializationSchema,
  evalMaterialFileSchema,
  evalMaterialPath,
  readEvalCanonicalContext,
} from "@springbrand/eval-harness";
import type { z } from "zod";
import { MATERIAL_FILE_BYTES, MATERIAL_TOTAL_BYTES } from "../limits.js";
import { BundleFileError } from "./bundle-errors.js";

export type MaterialFile = z.output<typeof evalMaterialFileSchema>;
export type SessionContent = z.output<typeof evalInitialContextSchema>;
type ResourceLocation = { readonly path: string; readonly ownerDirectory: string };

/** SP's initialization contract owns the per-material file count and file shape. */
const materialFilesSchema = evalInitializationSchema.shape.initialMaterials.unwrap().shape.files.min(1);

export interface BundleDirectory {
  resolveInitialMaterials(ownerUserId: string, reference: InitialMaterialsRef): Promise<readonly MaterialFile[]>;
  resolveInitialSession(ownerUserId: string, reference: InitialSessionRef): Promise<SessionContent | undefined>;
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
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (cause) {
      throw new BundleFileError("invalid", "Initial Bundle resource is not valid JSON", { cause });
    }
  }

  async function writeResource(location: ResourceLocation, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    const parent = dirname(location.path);
    try {
      await ensureDirectory(location.ownerDirectory);
      await ensureDirectory(dirname(parent));
      await ensureDirectory(parent);
      if (!insideRoot(location.ownerDirectory, await realpath(parent))) {
        throw new BundleFileError("invalid", "Initial Bundle resource escapes its owner directory");
      }
      const temporary = join(parent, `.${crypto.randomUUID()}.upload`);
      await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        await link(temporary, location.path);
      } catch (error) {
        if (!isExisting(error)) throw error;
        if (JSON.stringify(await readResource(location)) !== serialized) {
          throw new BundleFileError("conflict", "Initial Bundle resource already has different content");
        }
      } finally {
        await unlink(temporary);
      }
    } catch (error) {
      if (error instanceof BundleFileError) throw error;
      throw unavailable(error);
    }
  }

  async function removeResource(location: ResourceLocation): Promise<void> {
    try {
      await unlink(location.path);
    } catch (error) {
      if (!isMissing(error)) throw unavailable(error);
    }
  }

  return {
    async uploadInitialMaterials(ownerUserId, reference, files) {
      await writeResource(materialsLocation(ownerUserId, reference), { files: validateMaterialFiles(files) });
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
      return validateMaterialFiles(manifest.files);
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
    throw new BundleFileError("invalid", "Initial Bundle directory must not be a symbolic link");
  }
}

function validateMaterialFiles(value: unknown): readonly MaterialFile[] {
  let files: readonly MaterialFile[];
  try {
    files = materialFilesSchema.parse(value);
    for (const file of files) evalMaterialPath("", file.path);
  } catch (cause) {
    throw new BundleFileError("invalid", "Initial material files are invalid", { cause });
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new BundleFileError("invalid", "Initial material file paths must be unique");
  }
  let total = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.contentBase64, "base64");
    total += size;
    if (size > MATERIAL_FILE_BYTES || total > MATERIAL_TOTAL_BYTES) {
      throw new BundleFileError("too-large", "Initial materials are too large");
    }
  }
  return files;
}

/** SP imports the Session; its canonical-context reader is the single validity rule. */
function validateSessionContent(value: unknown): SessionContent {
  try {
    const context = evalInitialContextSchema.parse(value);
    readEvalCanonicalContext(context);
    return context;
  } catch (cause) {
    throw new BundleFileError("invalid", "Initial Session content cannot be imported by SP", { cause });
  }
}

function platformId(value: string, name: string): string {
  const parsed = platformIdSchema.safeParse(value);
  if (!parsed.success) throw new BundleFileError("invalid", `Invalid ${name} identity`, { cause: parsed.error });
  return parsed.data;
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
