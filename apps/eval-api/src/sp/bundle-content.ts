import { parseStrictJson } from "@eval-platform/eval-dataset";
import {
  evalInitialContextSchema,
  evalInitializationSchema,
  evalMaterialFileSchema,
  evalMaterialPath,
  readEvalCanonicalContext,
} from "@springbrand/eval-harness";
import type { z } from "zod";
import { MATERIAL_FILE_BYTES, MATERIAL_TOTAL_BYTES, ZIP_ERRORS } from "../limits.js";
import { BundleFileError, errorMessage, type BundleFileErrorDetail } from "./bundle-errors.js";

export type MaterialFile = z.output<typeof evalMaterialFileSchema>;
export type SessionContent = z.output<typeof evalInitialContextSchema>;
/** How error details name one material's file list and each file in it. */
type MaterialLabels = { readonly files: string; readonly file: (index: number) => string };

/** SP's initialization contract owns the per-material file count and file shape. */
export const materialFilesSchema = evalInitializationSchema.shape.initialMaterials.unwrap().shape.files.min(1);

const listLabels: MaterialLabels = { files: "files", file: (index) => `files.${index}` };

/** The single Material content rule for uploads, ZIP imports and stored manifests. */
export function validateMaterialFiles(value: unknown, labels: MaterialLabels = listLabels): readonly MaterialFile[] {
  const parsed = materialFilesSchema.safeParse(value);
  if (!parsed.success) {
    throw invalid("Initial material files are invalid", parsed.error.issues.map(({ path, message }) =>
      typeof path[0] === "number"
        ? { path: labels.file(path[0]), errMsg: issueMessage(path.slice(1), message) }
        : { path: labels.files, errMsg: issueMessage(path, message) }));
  }
  const files = parsed.data;
  const details: BundleFileErrorDetail[] = [];
  const paths = new Set<string>();
  for (const [index, file] of files.entries()) {
    try {
      evalMaterialPath("", file.path);
    } catch (error) {
      details.push({ path: labels.file(index), errMsg: errorMessage(error) });
    }
    if (paths.has(file.path)) details.push({ path: labels.file(index), errMsg: `Duplicate material file path ${file.path}` });
    paths.add(file.path);
  }
  if (details.length > 0) throw invalid("Initial material files are invalid", details);
  let total = 0;
  for (const [index, file] of files.entries()) {
    const size = Buffer.byteLength(file.contentBase64, "base64");
    total += size;
    if (size > MATERIAL_FILE_BYTES) throw tooLarge(labels.file(index), `A material file may contain at most ${MATERIAL_FILE_BYTES} bytes`);
    if (total > MATERIAL_TOTAL_BYTES) throw tooLarge(labels.files, `A material may contain at most ${MATERIAL_TOTAL_BYTES} bytes`);
  }
  return files;
}

/**
 * The single Session content rule. Content is strict JSON (duplicate keys rejected) so failures name
 * a JSONL line as `<label>:<line>`; SP's canonical-context reader then decides importability.
 */
export function validateSessionContent(value: unknown, label = "content"): SessionContent {
  const message = "Initial Session content cannot be imported by SP";
  const parsed = evalInitialContextSchema.safeParse(value);
  if (!parsed.success) {
    throw invalid(message, parsed.error.issues.map(({ path, message: issue }) => ({ path: label, errMsg: issueMessage(path, issue) })));
  }
  const context = parsed.data;
  const details: BundleFileErrorDetail[] = [];
  const documents = context.format === "json" ? [context.content] : context.content.split(/\r?\n/u);
  for (const [index, document] of documents.entries()) {
    if (context.format === "jsonl" && !document.trim()) continue;
    try {
      parseStrictJson(document);
    } catch (error) {
      details.push({ path: context.format === "json" ? label : `${label}:${index + 1}`, errMsg: errorMessage(error) });
      if (details.length >= ZIP_ERRORS) break;
    }
  }
  if (details.length > 0) throw invalid(message, details);
  try {
    readEvalCanonicalContext(context);
  } catch (error) {
    throw invalid(message, [{ path: label, errMsg: errorMessage(error) }]);
  }
  return context;
}

function invalid(message: string, details: readonly BundleFileErrorDetail[]): BundleFileError {
  return new BundleFileError("invalid", message, { details: details.slice(0, ZIP_ERRORS) });
}

function tooLarge(path: string, errMsg: string): BundleFileError {
  return new BundleFileError("too-large", "Initial materials are too large", { details: [{ path, errMsg }] });
}

function issueMessage(path: readonly PropertyKey[], message: string): string {
  return path.length === 0 ? message : `${path.map(String).join(".")}: ${message}`;
}
