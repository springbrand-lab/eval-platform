import { parseStrictJson } from "@eval-platform/eval-dataset";
import {
  EVAL_INITIALIZATION_MAX_BYTES,
  evalInitialContextSchema,
  evalMaterialFilesByteSize,
  evalMaterialFilesSchema,
  readEvalCanonicalContext,
  type EvalMaterialFile,
} from "@springbrand/eval-harness";
import { z } from "zod";
import { BUNDLE_ERROR_DETAILS } from "../limits.js";
import { BundleFileError, errorMessage, type BundleFileErrorDetail } from "./bundle-errors.js";

export type MaterialFile = EvalMaterialFile;
/** One Material's validated files and their total decoded bytes. */
type MaterialContent = { readonly files: readonly MaterialFile[]; readonly byteSize: number };
export type SessionContent = z.output<typeof evalInitialContextSchema>;
/** How error details name one material's file list and each file in it. */
type MaterialLabels = { readonly files: string; readonly file: (index: number) => string };

/** SP's Material files rule; Eval also requires a file. */
const filesSchema = evalMaterialFilesSchema.min(1, "A material must contain at least one file");

const listLabels: MaterialLabels = { files: "files", file: (index) => `files.${index}` };

/** The single Material content rule for uploads, ZIP imports and stored manifests. */
export function validateMaterialFiles(value: unknown, labels: MaterialLabels = listLabels): MaterialContent {
  const parsed = filesSchema.safeParse(value);
  if (!parsed.success) {
    const details = (issues: readonly z.core.$ZodIssue[]) => issues.map(({ path: [index, ...path], message }) =>
      typeof index === "number"
        ? { path: labels.file(index), errMsg: issueMessage(path, message) }
        : { path: labels.files, errMsg: message });
    const tooBig = parsed.error.issues.filter(({ code }) => code === "too_big");
    if (tooBig.length > 0) throw tooLarge(details(tooBig));
    throw invalid("Initial material files are invalid", details(parsed.error.issues));
  }
  const files = parsed.data;
  const byteSize = evalMaterialFilesByteSize(files);
  requireInitializationBudget(byteSize, labels.files);
  return { files, byteSize };
}

/** SP's whole-initialization budget, applied to one Material and to the Materials one Data field binds. */
export function requireInitializationBudget(byteSize: number, path: string): void {
  if (byteSize > EVAL_INITIALIZATION_MAX_BYTES) {
    throw tooLarge([{ path, errMsg: `Initial materials may contain at most ${EVAL_INITIALIZATION_MAX_BYTES} bytes` }]);
  }
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
      if (details.length >= BUNDLE_ERROR_DETAILS) break;
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
  return new BundleFileError("invalid", message, { details: details.slice(0, BUNDLE_ERROR_DETAILS) });
}

function tooLarge(details: readonly BundleFileErrorDetail[]): BundleFileError {
  return new BundleFileError("too-large", "Initial materials are too large", { details: details.slice(0, BUNDLE_ERROR_DETAILS) });
}

function issueMessage(path: readonly PropertyKey[], message: string): string {
  return path.length === 0 ? message : `${path.map(String).join(".")}: ${message}`;
}
