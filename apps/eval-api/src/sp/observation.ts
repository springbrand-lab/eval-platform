import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spPiTrajectoryIdentityParts, type SpPiTrajectoryRecordReference } from "@eval-platform/eval-contracts";
import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import {
  EVAL_EVIDENCE_FILE_MAX_BYTES, EVAL_EVIDENCE_SHA256_HEADER, EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX_BYTES,
  EVAL_TRAJECTORY_RECORD_IDENTITY_HEADER, EVAL_TRAJECTORY_RECORD_INGEST_SEQ_HEADER,
  EVAL_TRAJECTORY_RECORD_THROUGH_SEQ_HEADER,
  evalNativeRecordReferenceSchema,
} from "@springbrand/eval-harness";
import { ApiError, type HttpClient, type HttpRequestOptions } from "@springbrand/http/client";
import { httpOriginSchema } from "../config/env.js";
import { createSpHttpClient, EvalSpApiError, EvalSpTransportError, throwSpClientError, type Fetch } from "./http.js";
import { verifiedSafePiRecordBytes } from "./native-record-stream.js";

/** One Eval SP Chat of the service account. */
export interface ChatRef {
  readonly ownerUserId: string;
  readonly chatId: string;
}

export interface TrajectoryQuery {
  readonly limit?: number;
  /** Forward-only cursor; zero starts at the beginning of the frozen Chat. */
  readonly afterSeq?: number;
  readonly throughSeq?: number;
}

/** One *fully verified* original SAFE record; dispose removes its private temporary file. */
export interface VerifiedTrajectoryRecord {
  readonly byteLength: number;
  readonly sha256: string;
  bytes(): AsyncIterable<Uint8Array>;
  dispose(): Promise<void>;
}

export interface WorkspaceFile {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly contentType: string;
  readonly contentLength: string | null;
}

/** GET-only reads of Chats the service account owns; nothing here can drive an Agent. */
export interface SpObservationClient {
  messages(chat: ChatRef): Promise<unknown>;
  tree(chat: ChatRef): Promise<unknown>;
  file(chat: ChatRef, path: string): Promise<WorkspaceFile>;
  trajectory(chat: ChatRef, query: TrajectoryQuery, signal?: AbortSignal): Promise<unknown>;
  /** Fixed owner-session byte route; no record bytes can leave before full verification. */
  trajectoryRecord(chat: ChatRef, row: SpPiTrajectoryRecordReference,
    signal?: AbortSignal): Promise<VerifiedTrajectoryRecord>;
}

const TIMEOUT_MS = 30_000;
/** Workspace files above this size are offered for download only by Eval SP itself, never through Eval. */
export const OBSERVATION_FILE_BYTES = 10_000_000;

export function createSpObservationClient(input: {
  readonly agentOrigin: string;
  readonly apiOrigin: string;
  /** An Origin Eval SP trusts for browser reads; the reads are made server-side with the service session. */
  readonly trustedOrigin: string;
  readonly sessionToken: string;
  readonly fetch?: Fetch;
}): SpObservationClient {
  const headers = { Authorization: `Bearer ${input.sessionToken}`, Origin: input.trustedOrigin };
  const agent = createSpHttpClient({ origin: input.agentOrigin, responseMode: "json", timeoutMs: TIMEOUT_MS,
    maxResponseBytes: OBSERVATION_FILE_BYTES, headers, fetch: input.fetch });
  const api = createSpHttpClient({ origin: input.apiOrigin, responseMode: "envelope", timeoutMs: TIMEOUT_MS,
    maxResponseBytes: OBSERVATION_FILE_BYTES, headers, fetch: input.fetch });
  const apiOrigin = httpOriginSchema.parse(input.apiOrigin);
  const fetchSp = input.fetch ?? globalThis.fetch;
  const chatPath = (chat: ChatRef, suffix: string) =>
    `/agents/inbox/${encodeURIComponent(chat.ownerUserId)}/chat-sockets/${encodeURIComponent(chat.chatId)}/${suffix}`;

  async function get<T>(http: HttpClient, path: string, options?: HttpRequestOptions) {
    try {
      return await http.request<T>(path, options);
    } catch (error) {
      if (options?.responseMode === "blob" && error instanceof ApiError && error.code === "RESPONSE_TOO_LARGE") {
        throw new HttpError("CATALOG_PAYLOAD_TOO_LARGE", "Workspace file is too large to preview", { cause: error });
      }
      throwSpClientError(error);
    }
  }

  return {
    async messages(chat) {
      return (await get(agent, chatPath(chat, "get-messages"), { params: { view: "hydration" } })).data;
    },
    async tree(chat) {
      return (await get(agent, chatPath(chat, "workspace/tree"))).data;
    },
    async file(chat, path) {
      // The shared transport counts actual streamed bytes before any response is relayed to Web.
      const { data } = await get<Blob>(agent, chatPath(chat, "workspace/content"), { params: { path }, responseMode: "blob" });
      return { body: data.stream(), contentType: data.type || "application/octet-stream", contentLength: String(data.size) };
    },
    async trajectory(chat, query, signal) {
      const { afterSeq = 0, limit = 100, throughSeq } = query;
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200
        || throughSeq !== undefined && (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || afterSeq > throughSeq)) {
        throw new HttpError("REQUEST_INVALID_INPUT", "Invalid frozen Chat trajectory cursor");
      }
      return (await get(api, `/api/chats/${encodeURIComponent(chat.chatId)}/trajectory`, {
        params: { afterSeq, limit, ...(throughSeq === undefined ? {} : { throughSeq }) },
        maxResponseBytes: EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX_BYTES, ...(signal ? { signal } : {}),
      })).data;
    },
    async trajectoryRecord(chat, row, signal) {
      const parsed = evalNativeRecordReferenceSchema.safeParse(row);
      const reference = parsed.success ? parsed.data.reference : null;
      if (!reference || spPiTrajectoryIdentityParts(reference.identity)?.[1] !== chat.chatId
        || reference.byteLength > EVAL_EVIDENCE_FILE_MAX_BYTES) {
        throw new HttpError("REQUEST_INVALID_INPUT", "Invalid current Chat record reference");
      }
      // The path is fixed; no caller supplies a URL, credential, Submission or Workspace path.
      const url = new URL(`/api/chats/${encodeURIComponent(chat.chatId)}/trajectory/records/${row.ingestSeq}`, apiOrigin);
      url.search = new URLSearchParams({
        throughSeq: String(reference.throughSeq), identity: reference.identity,
        byteLength: String(reference.byteLength), sha256: reference.sha256,
      }).toString();
      const activeSignal = signal === undefined
        ? AbortSignal.timeout(5 * 60_000)
        : AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
      let response: Response;
      try {
        response = await fetchSp(url, {
          method: "GET", redirect: "error", headers,
          signal: activeSignal,
        });
      } catch (cause) {
        if (signal?.aborted) throw cause;
        throw new EvalSpTransportError(cause);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new EvalSpApiError(response.status, null);
      }
      const mime = response.headers.get("content-type") ?? "";
      const length = response.headers.get("content-length");
      const boundHeaders: readonly (readonly [string, string])[] = [
        [EVAL_EVIDENCE_SHA256_HEADER, reference.sha256],
        [EVAL_TRAJECTORY_RECORD_IDENTITY_HEADER, encodeURIComponent(reference.identity)],
        [EVAL_TRAJECTORY_RECORD_INGEST_SEQ_HEADER, String(row.ingestSeq)],
        [EVAL_TRAJECTORY_RECORD_THROUGH_SEQ_HEADER, String(reference.throughSeq)],
      ];
      if (!/^application\/(?:json|octet-stream)(?:\s*;\s*charset=utf-8)?$/iu.test(mime)
        || length !== null && length !== String(reference.byteLength)
        || response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity"
        || boundHeaders.some(([name, expected]) => {
          const actual = response.headers.get(name);
          return actual !== null && actual !== expected;
        })
        || !response.body) {
        await response.body?.cancel();
        throw new HttpError("RESPONSE_INVALID", "SP returned invalid SAFE Pi record headers");
      }
      const verified = verifiedSafePiRecordBytes(response.body, {
        identity: reference.identity, byteLength: reference.byteLength, sha256: reference.sha256,
        maxBytes: EVAL_EVIDENCE_FILE_MAX_BYTES, scope: { kind: "chat", chatId: chat.chatId },
      });
      // Spool only this bounded record while the existing SAFE byte verifier drains it
      // to EOF. Never release a prefix if hash, length, JSON, identity or parent fails.
      let directory: string;
      try {
        directory = await mkdtemp(join(tmpdir(), "eval-trajectory-"));
      } catch (cause) {
        await verified.cancel(cause).catch(() => undefined);
        throw new HttpError("RESPONSE_INVALID", "Cannot privately verify SAFE Pi record bytes", { cause });
      }
      const path = join(directory, "record.json");
      let writer: Awaited<ReturnType<typeof open>> | undefined;
      let sealed = false;
      const reader = verified.getReader();
      const abort = () => { void reader.cancel(activeSignal.reason).catch(() => undefined); };
      activeSignal.addEventListener("abort", abort, { once: true });
      try {
        writer = await open(path, "wx", 0o600);
        for (;;) {
          if (activeSignal.aborted) throw activeSignal.reason;
          const next = await reader.read();
          if (activeSignal.aborted) throw activeSignal.reason;
          if (next.done) break; // verifier's flush checks the *entire* source here
          await writer.writeFile(next.value);
        }
        if (activeSignal.aborted) throw activeSignal.reason;
        await writer.close();
        if (activeSignal.aborted) throw activeSignal.reason;
        sealed = true;
        return {
          byteLength: reference.byteLength, sha256: reference.sha256,
          async *bytes(): AsyncIterable<Uint8Array> {
            const stream = createReadStream(path, { highWaterMark: 64 * 1024, signal });
            try {
              for await (const bytes of stream) yield bytes as Uint8Array;
            } finally { stream.destroy(); }
          },
          dispose: () => rm(directory, { recursive: true, force: true }),
        };
      } catch (cause) {
        await reader.cancel(cause).catch(() => undefined);
        if (signal?.aborted) throw cause;
        throw new HttpError("RESPONSE_INVALID", "SP returned invalid SAFE Pi record bytes", { cause });
      } finally {
        activeSignal.removeEventListener("abort", abort);
        reader.releaseLock();
        if (!sealed) {
          await writer?.close().catch(() => undefined);
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
  };
}
