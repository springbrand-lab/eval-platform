import { extname } from "node:path";
import { EVAL_INITIAL_FILE_MAX_BYTES, inspectStrictZip, StrictZipError, type StrictZipEntry, type StrictZipEntryLimit, type StrictZipErrorCode } from "@springbrand/eval-harness";
import { lookup } from "mime-types";
import { isCatalogLabel } from "../db/catalog-metadata.js";
import {
  ZIP_ARCHIVE_BYTES, ZIP_ENTRIES, BUNDLE_ERROR_DETAILS, ZIP_EXPANDED_BYTES, ZIP_PATH_CHARS, ZIP_RESOURCES,
} from "../limits.js";
import { BundleFileError, type BundleFileErrorDetail } from "../sp/bundle-errors.js";
import { validateMaterialFiles, validateSessionContent, type MaterialFile, type SessionContent } from "../sp/bundle-content.js";

type MaterialZipResource = { readonly source: string; readonly files: readonly MaterialFile[] };
type SessionZipResource = { readonly source: string; readonly content: SessionContent };

/** Archive-level failures are reported under this path; entry failures use the entry path. */
const ARCHIVE_PATH = "zip";
const tooLargeCodes: ReadonlySet<StrictZipErrorCode> = new Set(["too-many-entries", "entry-too-large", "aggregate-too-large", "path-too-long"]);
const sessionFormats: Readonly<Record<string, SessionContent["format"]>> = { ".json": "json", ".jsonl": "jsonl" };
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Collects entry errors and rejects the whole archive once BUNDLE_ERROR_DETAILS are known. */
class ZipErrors {
  private readonly details: BundleFileErrorDetail[] = [];

  add(path: string, errMsg: string): void {
    this.details.push({ path, errMsg });
    if (this.details.length >= BUNDLE_ERROR_DETAILS) this.throwIfAny();
  }

  /** Record an invalid-content error of one resource; every other failure, including limits, ends the import. */
  addInvalid(error: unknown, source: string): void {
    if (!(error instanceof BundleFileError) || error.reason !== "invalid") throw error;
    const details = error.details?.length ? error.details : [{ path: source, errMsg: error.message }];
    for (const detail of details) this.add(detail.path, detail.errMsg);
  }

  throwIfAny(): void {
    if (this.details.length > 0) {
      throw zipError("invalid", this.details.slice(0, BUNDLE_ERROR_DETAILS));
    }
  }
}

function zipError(reason: "invalid" | "too-large", details: readonly BundleFileErrorDetail[]): BundleFileError {
  return new BundleFileError(reason, reason === "invalid" ? "ZIP archive is invalid" : "ZIP archive is too large", { details });
}

function zipTooLarge(errMsg: string): BundleFileError {
  return zipError("too-large", [{ path: ARCHIVE_PATH, errMsg }]);
}

/** SP's strict-ZIP inspector owns archive safety; its first violation rejects the archive. */
async function inspect(bytes: Uint8Array, entryLimit?: StrictZipEntryLimit): Promise<readonly StrictZipEntry[]> {
  if (bytes.byteLength > ZIP_ARCHIVE_BYTES) throw zipTooLarge(`A ZIP archive may contain at most ${ZIP_ARCHIVE_BYTES} bytes`);
  try {
    const { entries } = await inspectStrictZip(bytes, {
      entries: ZIP_ENTRIES,
      maxEntryBytes: Infinity,
      maxExpandedBytes: ZIP_EXPANDED_BYTES,
      maxCompressionRatio: Infinity,
      pathCharacters: ZIP_PATH_CHARS,
    }, entryLimit, { retainBytes: true });
    return entries;
  } catch (error) {
    if (!(error instanceof StrictZipError)) throw error;
    throw zipError(tooLargeCodes.has(error.code) ? "too-large" : "invalid", [{ path: error.path ?? ARCHIVE_PATH, errMsg: error.message }]);
  }
}

/** Each top-level directory is one Material of its inner files; each root file is a one-file Material. */
export async function readMaterialZip(bytes: Uint8Array): Promise<readonly MaterialZipResource[]> {
  const errors = new ZipErrors();
  const entries = await inspect(bytes, () => ({
    maxBytes: EVAL_INITIAL_FILE_MAX_BYTES,
    message: `A material file may contain at most ${EVAL_INITIAL_FILE_MAX_BYTES} bytes`,
  }));
  const topLevel = (path: string) => path.split("/", 1)[0]!;
  const sources = new Set(entries.map(({ path }) => topLevel(path)));
  requireResourceCount(sources.size);
  const fileSources = new Set(entries.flatMap(({ path, directory }) => directory ? [] : [topLevel(path)]));
  for (const source of sources) {
    if (!fileSources.has(source)) errors.add(source, "A Material directory must contain at least one file");
  }
  const directories = new Set(entries.flatMap(({ path, directory }) => {
    const segments = path.split("/");
    return segments.slice(0, directory ? undefined : -1).map((_, index) => segments.slice(0, index + 1).join("/"));
  }));
  const groups = new Map<string, { names: string[]; files: MaterialFile[] }>();
  for (const { path, bytes: content, directory } of entries) {
    if (directory) continue;
    if (directories.has(path)) {
      errors.add(path, "ZIP entry is both a file and a directory");
      continue;
    }
    const separator = path.indexOf("/");
    const source = separator < 0 ? path : path.slice(0, separator);
    if (!isCatalogLabel(source)) {
      errors.add(path, "ZIP resource name must be nonblank");
      continue;
    }
    const group = groups.get(source) ?? { names: [], files: [] };
    groups.set(source, group);
    group.names.push(path);
    group.files.push({
      path: separator < 0 ? `/${path}` : path.slice(separator),
      mediaType: lookup(path) || "application/octet-stream",
      contentBase64: Buffer.from(content!).toString("base64"),
    });
  }
  const resources: MaterialZipResource[] = [];
  for (const [source, { names, files }] of groups) {
    try {
      resources.push({ source, files: validateMaterialFiles(files, { files: source, file: (index) => names[index] ?? source }).files });
    } catch (error) {
      errors.addInvalid(error, source);
    }
  }
  return accepted(resources, errors);
}

/** Each root `*.json` or `*.jsonl` file is one Session in that format. */
export async function readSessionZip(bytes: Uint8Array): Promise<readonly SessionZipResource[]> {
  const errors = new ZipErrors();
  const files: { name: string; format: SessionContent["format"]; content: Uint8Array }[] = [];
  const entries = await inspect(bytes);
  requireResourceCount(entries.filter(({ directory }) => !directory).length);
  for (const { path, bytes: content, directory } of entries) {
    const format = sessionFormats[extname(path)];
    if (directory || path.includes("/")) errors.add(path, "Session ZIP entries must be files at the archive root");
    else if (!format) errors.add(path, "Session ZIP entries must be named *.json or *.jsonl");
    else files.push({ name: path, format, content: content! });
  }
  const resources: SessionZipResource[] = [];
  for (const { name, format, content } of files) {
    const text = decodeUtf8(content);
    if (text === undefined) {
      errors.add(name, "Session file must be UTF-8 text");
      continue;
    }
    try {
      resources.push({ source: name, content: validateSessionContent({ format, content: text }, name) });
    } catch (error) {
      errors.addInvalid(error, name);
    }
  }
  return accepted(resources, errors);
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

function requireResourceCount(count: number): void {
  if (count > ZIP_RESOURCES) throw zipTooLarge(`A ZIP archive may contain at most ${ZIP_RESOURCES} Bundle resources`);
}

function accepted<T>(resources: readonly T[], errors: ZipErrors): readonly T[] {
  errors.throwIfAny();
  if (resources.length === 0) errors.add(ARCHIVE_PATH, "ZIP archive contains no Bundle resources");
  errors.throwIfAny();
  return resources;
}
