import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { platformIdSchema } from "@eval-platform/eval-dataset";
import type { Context } from "hono";
import { z } from "zod";
import { fileResponse } from "../lib/file-response.js";
import type { AppBindings } from "../lib/types.js";
import { entityIdSchema } from "../routes/schemas.js";
import { displayJson, type DisplayJson } from "./common.js";
import { readOwnedEvaluationResult } from "./metrics.js";
import { readOwnedOutputSchema, readOwnedProjectSchema } from "./options.js";
import { asStream } from "./trajectory.js";

export const MANAGEMENT_DOCUMENT_PATH = "/mcp/eval-management/documents";
const querySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("output_schema"), outputSchemaId: platformIdSchema }),
  z.strictObject({ kind: z.literal("project_schema"), projectId: entityIdSchema }),
  z.strictObject({ kind: z.literal("evaluation_result"), projectId: entityIdSchema,
    samplingId: entityIdSchema, evaluationId: entityIdSchema, runId: entityIdSchema.optional() }),
]);
type Query = z.output<typeof querySchema>;
const encoding = new TextEncoder();
const CHUNK_BYTES = 8_192;
const EMPTY: DisplayJson = { bytes: null, display: null, sourceRedacted: false };

function query(c: Context<AppBindings>): Query {
  if (c.req.url.length > 4_096) throw new HttpError("REQUEST_INVALID_INPUT", "Document query is too large");
  const parameters = new URL(c.req.url).searchParams;
  if (parameters.size > 5 || new Set(parameters.keys()).size !== parameters.size) {
    throw new HttpError("REQUEST_INVALID_INPUT", "Duplicate document query field");
  }
  const parsed = querySchema.safeParse(Object.fromEntries(parameters));
  if (!parsed.success) throw new HttpError("REQUEST_INVALID_INPUT", "Invalid fixed document query");
  return parsed.data;
}

function sameDisplay(left: DisplayJson, right: DisplayJson) {
  return left.sourceRedacted === right.sourceRedacted
    && left.display?.sha256 === right.display?.sha256
    && left.display?.totalBytes === right.display?.totalBytes;
}

/** Every fixed source is owner-scoped; recheck its identity/current membership at the *end*. */
async function prepare(c: Context<AppBindings>, input: Query): Promise<{
  readonly document: DisplayJson;
  readonly identity: Record<string, unknown>;
  readonly recheck: () => Promise<void>;
}> {
  if (input.kind === "output_schema") {
    const schema = await readOwnedOutputSchema(c, input.outputSchemaId);
    const document = displayJson(schema.schema);
    return {
      document, identity: { kind: input.kind, outputSchemaId: input.outputSchemaId },
      async recheck() {
        const current = await readOwnedOutputSchema(c, input.outputSchemaId);
        const after = displayJson(current.schema);
        if (!sameDisplay(document, after)
          || document.display === null && JSON.stringify(current.schema) !== JSON.stringify(schema.schema)) {
          throw new HttpError("OUTPUT_SCHEMA_NOT_FOUND", "The output Schema changed during the download");
        }
      },
    };
  }
  if (input.kind === "project_schema") {
    const schema = await readOwnedProjectSchema(c, input.projectId);
    const document = displayJson(schema.content);
    return {
      document, identity: { kind: input.kind, projectId: input.projectId,
        outputSchemaId: schema.reference.outputSchemaId, digest: schema.reference.digest },
      async recheck() {
        const current = await readOwnedProjectSchema(c, input.projectId);
        const after = displayJson(current.content);
        if (current.reference.outputSchemaId !== schema.reference.outputSchemaId
          || current.reference.digest !== schema.reference.digest
          || JSON.stringify(current.content) !== JSON.stringify(schema.content)
          || !sameDisplay(document, after)) {
          throw new HttpError("OUTPUT_SCHEMA_NOT_FOUND", "The Project's frozen Schema changed during the download");
        }
      },
    };
  }
  const owned = await readOwnedEvaluationResult(c, input);
  const document = owned.hasParsedDocument
    ? displayJson(owned.output.rawJson, owned.privatePrompts, owned.displayScope) : EMPTY;
  return {
    document, identity: {
      kind: input.kind, projectId: input.projectId, samplingId: input.samplingId, evaluationId: input.evaluationId,
      ...(input.runId === undefined ? { runScope: "project_current" } : { runScope: "exact_run", runId: input.runId }),
      outputStatus: owned.output.outputStatus,
      validation: { status: owned.output.validation.status, reason: owned.output.validation.reason },
    },
    async recheck() {
      const current = await readOwnedEvaluationResult(c, input);
      const after = current.hasParsedDocument
        ? displayJson(current.output.rawJson, current.privatePrompts, current.displayScope) : EMPTY;
      if (current.hasParsedDocument !== owned.hasParsedDocument
        || current.output.content !== owned.output.content || current.output.contentHash !== owned.output.contentHash
        || current.output.outputStatus !== owned.output.outputStatus
        || current.output.validation.status !== owned.output.validation.status
        || current.output.validation.reason !== owned.output.validation.reason
        || !sameDisplay(document, after)) {
        throw new HttpError("EVALUATION_NOT_FOUND", "The Evaluation changed during the download");
      }
    },
  };
}

/**
 * Fixed-size base64 frames carry the displayed JSON bytes (including UTF-8
 * code points that cross a frame). Only a terminal manifest followed by EOF
 * authenticates the display; failure/cancellation never emits that manifest.
 */
async function* lines(document: DisplayJson, identity: Record<string, unknown>,
  recheck: () => Promise<void>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (document.bytes) {
    for (let offset = 0; offset < document.bytes.length; offset += CHUNK_BYTES) {
      if (signal.aborted) throw signal.reason;
      yield encoding.encode(`${JSON.stringify({
        type: "chunk", offset, base64: document.bytes.toString("base64", offset, offset + CHUNK_BYTES),
      })}\n`);
    }
  }
  if (signal.aborted) throw signal.reason;
  await recheck();
  if (signal.aborted) throw signal.reason;
  yield encoding.encode(`${JSON.stringify({
    type: "manifest", format: "eval-management-json/v1", ...identity,
    display: document.display, sourceRedacted: document.sourceRedacted,
    withheld: document.bytes === null && document.sourceRedacted,
    // Completion describes only the *displayed* canonical JSON or explicit null,
    // never the original text or a redacted field's missing source value.
    displayComplete: true,
  })}\n`);
}

/** Same management Bearer and fixed owner as MCP/trajectory, not a model tool. */
export async function streamDocument(c: Context<AppBindings>): Promise<Response> {
  const input = query(c);
  const { document, identity, recheck } = await prepare(c, input);
  const abort = new AbortController();
  const signal = AbortSignal.any([c.req.raw.signal, abort.signal]);
  return fileResponse({ body: asStream(lines(document, identity, recheck, signal), abort),
    contentType: "application/x-ndjson; charset=utf-8", contentLength: null });
}
