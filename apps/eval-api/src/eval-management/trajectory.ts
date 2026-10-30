import { createHash } from "node:crypto";
import {
  isSafePiTrajectoryRecord, isSpPiTrajectoryReference, spPiTrajectoryIdentityParts,
  type SpPiTrajectoryPage,
} from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import {
  evalEvidenceTrajectoryPageSchema, EVAL_EVIDENCE_FILE_MAX_BYTES, EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX,
} from "@springbrand/eval-harness";
import type { Context } from "hono";
import { z } from "zod";
import { fileResponse } from "../lib/file-response.js";
import type { AppBindings } from "../lib/types.js";
import type { ChatRef } from "../sp/observation.js";
import { record } from "./common.js";
import { ownedTrajectoryChat } from "./inspect.js";
import { inspectCaseSchema } from "./schemas.js";

export const MANAGEMENT_TRAJECTORY_PATH = "/mcp/eval-management/trajectories";
const querySchema = z.strictObject({
  ...inspectCaseSchema.shape, role: z.enum(["subject", "evaluator"]),
}).superRefine((value, ctx) => {
  if ((value.role === "evaluator") !== (value.evaluationId !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Evaluation ID is required only for the Evaluator" });
  }
});
type Query = z.output<typeof querySchema>;
const invalid = () => new HttpError("RESPONSE_INVALID", "SP returned an invalid SAFE Pi trajectory page");
const encoding = new TextEncoder();
// SP and the public schema bound each page to 200 rows / 4 MB; do not fetch one record per request.
const PAGE_LIMIT = EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX;

/** Public SP SAFE page is canonical; also bind it to this one Chat and frozen cursor.
 * Keep the original parsed record, never Zod's projected copy of Pi fields. */
function nativePage(value: unknown, chatId: string, afterSeq: number, throughSeq?: number): SpPiTrajectoryPage {
  if (!evalEvidenceTrajectoryPageSchema.safeParse(value).success) throw invalid();
  const page = value as SpPiTrajectoryPage;
  if (page.records.length > PAGE_LIMIT || page.cursor.throughSeq < afterSeq
    || throughSeq !== undefined && page.cursor.throughSeq !== throughSeq) throw invalid();
  let last = afterSeq;
  for (const row of page.records) {
    if (row.ingestSeq <= last || row.ingestSeq > page.cursor.throughSeq) throw invalid();
    if (isSpPiTrajectoryReference(row)) {
      if (row.reference.throughSeq !== page.cursor.throughSeq
        || spPiTrajectoryIdentityParts(row.reference.identity)?.[1] !== chatId
        || row.reference.byteLength > EVAL_EVIDENCE_FILE_MAX_BYTES) throw invalid();
    } else if (!isSafePiTrajectoryRecord(row.record) || row.record.resource.sessionId !== chatId
      || row.record.parent !== undefined && record(row.record.parent.resource)?.sessionId !== chatId) {
      throw invalid();
    }
    last = row.ingestSeq;
  }
  if (page.nextAfterSeq !== null && (page.records.length === 0 || page.nextAfterSeq !== last
    || last >= page.cursor.throughSeq)) throw invalid();
  return page;
}

function query(c: Context<AppBindings>): Query {
  if (c.req.url.length > 32_768) throw new HttpError("REQUEST_INVALID_INPUT", "Trajectory query is too large");
  const parameters = new URL(c.req.url).searchParams;
  if (parameters.size > 5 || new Set(parameters.keys()).size !== parameters.size) {
    throw new HttpError("REQUEST_INVALID_INPUT", "Duplicate trajectory query field");
  }
  const parsed = querySchema.safeParse(Object.fromEntries(parameters));
  if (!parsed.success) throw new HttpError("REQUEST_INVALID_INPUT", "Invalid fixed trajectory query");
  return parsed.data;
}

/** A failed/aborted stream has no terminal manifest; the trusted adapter MUST reject it. */
async function* lines(c: Context<AppBindings>, input: Query, chat: ChatRef,
  first: SpPiTrajectoryPage, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const records = createHash("sha256");
  const throughSeq = first.cursor.throughSeq;
  let page = first;
  let afterSeq = 0;
  let recordCount = 0;
  for (;;) {
    if (signal.aborted) throw signal.reason;
    for (const row of page.records) {
      if (signal.aborted) throw signal.reason;
      const prefix = encoding.encode(`{"ingestSeq":${row.ingestSeq},"record":`);
      const suffix = encoding.encode("}\n");
      if (isSpPiTrajectoryReference(row)) {
        // Only the verified spool is made available: no JSONL prefix or SP bytes
        // can be sent before the full reference has passed length/hash/SAFE checks.
        const verified = await c.env.observation.trajectoryRecord(chat, row, signal);
        try {
          if (signal.aborted) throw signal.reason;
          if (verified.byteLength !== row.reference.byteLength || verified.sha256 !== row.reference.sha256) throw invalid();
          records.update(prefix);
          yield prefix;
          let transferred = 0;
          const transferredHash = createHash("sha256");
          for await (const part of verified.bytes()) {
            if (signal.aborted) throw signal.reason;
            transferred += part.byteLength;
            if (transferred > row.reference.byteLength) throw invalid();
            transferredHash.update(part);
            records.update(part);
            yield part;
          }
          if (transferred !== row.reference.byteLength || transferredHash.digest("hex") !== row.reference.sha256) throw invalid();
          records.update(suffix);
          yield suffix;
        } finally {
          await verified.dispose();
        }
      } else {
        // The SP page has already passed its public SAFE schema and Chat checks.
        // Reserialization preserves every parsed Pi field, without 4-KiB truncation.
        const bytes = encoding.encode(JSON.stringify(row.record));
        if (bytes.byteLength > EVAL_EVIDENCE_FILE_MAX_BYTES) throw invalid();
        for (const part of [prefix, bytes, suffix]) {
          records.update(part);
          yield part;
        }
      }
      recordCount++;
    }
    if (page.nextAfterSeq === null) break; // authoritative terminal page under frozen cutoff
    afterSeq = page.nextAfterSeq;
    page = nativePage(await c.env.observation.trajectory(chat,
      { afterSeq, throughSeq, limit: PAGE_LIMIT }, signal), chat.chatId, afterSeq, throughSeq);
  }
  // A long-running stream must not claim success if its Project or stage was replaced.
  if (signal.aborted) throw signal.reason;
  const current = await ownedTrajectoryChat(c, input);
  if (signal.aborted) throw signal.reason;
  if (current.ownerUserId !== chat.ownerUserId || current.chatId !== chat.chatId) {
    throw new HttpError("EVAL_SP_FORBIDDEN", "The Chat changed during the export");
  }
  const manifest = {
    type: "manifest", format: first.format, projectId: input.projectId, samplingId: input.samplingId,
    ...(input.runId === undefined ? { runScope: "project_current" } : { runScope: "exact_run", runId: input.runId }),
    role: input.role, ...(input.evaluationId === undefined ? {} : { evaluationId: input.evaluationId }),
    chatId: chat.chatId, throughSeq, recordCount, recordsSha256: records.digest("hex"), complete: true,
  };
  yield encoding.encode(`${JSON.stringify(manifest)}\n`);
}

/** A failed or cancelled management download never appends a success manifest. */
export function asStream(source: AsyncGenerator<Uint8Array>, abort: AbortController): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await source.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        // The response may already have started. Never emit an apparent terminal
        // success or a JSON error line into a partially transferred JSONL file.
        try { controller.error(error); } catch { /* already cancelled */ }
      }
    },
    async cancel(reason) {
      abort.abort(reason);
      await source.return(undefined);
    },
  });
}

/** Authenticated by the router before this handler leases the fixed owner. */
export async function streamTrajectory(c: Context<AppBindings>): Promise<Response> {
  const input = query(c);
  const chat = await ownedTrajectoryChat(c, input);
  const first = nativePage(await c.env.observation.trajectory(chat, { afterSeq: 0, limit: PAGE_LIMIT }, c.req.raw.signal),
    chat.chatId, 0);
  const abort = new AbortController();
  const signal = AbortSignal.any([c.req.raw.signal, abort.signal]);
  return fileResponse({ body: asStream(lines(c, input, chat, first, signal), abort),
    contentType: "application/x-ndjson; charset=utf-8", contentLength: null });
}
