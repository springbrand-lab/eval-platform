import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import type {
  AgentFramework, AgentResourceReadiness, AgentResourceSnapshot, EvidenceLimits, JsonValue,
  NativeTrajectoryEntry, SpPiTrajectoryRecordReference,
} from "@eval-platform/eval-contracts";
import {
  EVIDENCE_SCHEMA_VERSION, SP_PI_TRAJECTORY_FORMAT, SP_PI_TRAJECTORY_RECORD_IDENTITY_HEADER,
  SP_PI_TRAJECTORY_RECORD_INGEST_SEQ_HEADER, SP_PI_TRAJECTORY_RECORD_THROUGH_SEQ_HEADER,
  isSpPiTrajectoryReference, isTerminalAgentStatus, nativeRecordMayBelongToScope,
  nativeTrajectoryEntrySchema, spPiTrajectoryIdentityParts, spPiTrajectoryRecordIdentity,
} from "@eval-platform/eval-contracts";
import type { InitialMaterialsRef, InitialSessionRef } from "@eval-platform/eval-dataset";
import { safeLog, type RuntimeLog } from "@eval-platform/eval-runtime";
import {
  AgentHandleNotFoundError,
  AgentIdentityConflictError,
  applyEvidenceLimits,
  type AgentHandle,
  type AgentSubmission,
  type CollectAgentResourcesInput,
  type Harness,
  type SubmitAgentInput,
} from "@eval-platform/eval-runtime/harness";
import {
  EVAL_EVIDENCE_FILE_MAX_BYTES,
  EVAL_EVIDENCE_SHA256_HEADER,
  EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX,
  EVAL_EVIDENCE_PATHS,
  EVAL_HARNESS_PATH,
  EVAL_SERVICE_HEADER,
  evalArtifactEvidencePath,
  evalEvidencePath,
  evalSubjectInputEvidencePath,
  evalTrajectoryEvidencePath,
  type EvalInitialization,
} from "@springbrand/eval-harness";
import { ApiError, parseHttpError } from "@springbrand/http/client";
import { isRequestCancelled } from "@springbrand/http/errors";
import { errorDiagnostics, readBytesLimited } from "@springbrand/http/server";
import WebSocket from "ws";
import { httpOriginSchema } from "../config/env.js";
import type { MaterialFile, SessionContent } from "./bundle-content.js";
import { SpHarnessError } from "./harness-error.js";
import {
  agentHandle,
  dataBinding,
  ensureChatRequest,
  evaluationOutput,
  evidenceArtifacts,
  evidenceFileReceipt,
  evidenceTrajectoryPage,
  executionOutput,
  finalReplyText,
  initializationRequest,
  resourceReadiness,
  resourceSnapshot,
  requireStopResult,
  submission,
  submitRequest,
  type SpResourceSnapshotWire,
} from "./harness-wire.js";
import { createSpHttpClient, type Fetch } from "./http.js";
import { observeTerminalSubmission, type OpenWebSocket } from "./submission-observer.js";

export { SpHarnessError } from "./harness-error.js";

const REQUEST_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
/** A full resource snapshot or evidence transfer (100+ MB) may take minutes. */
const TRANSFER_TIMEOUT_MS = 5 * 60_000;
/**
 * The HTTP client decodes a body into one string before `JSON.parse`; a UTF-8 byte yields at most
 * one UTF-16 unit, so any body within V8's maximum string length decodes. Larger is rejected.
 */
const MAX_JSON_RESPONSE_BYTES = bufferConstants.MAX_STRING_LENGTH;
/** A page is JSON, not a streaming byte file. Reject it before decoding unbounded native bodies. */
/** Match SP's public EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX_BYTES until its package is published. */
export const MAX_TRAJECTORY_PAGE_BYTES = 4_000_000;
const ERROR_BODY_BYTES = 64 * 1024;
/** SP's answer for an evidence read whose Submission or telemetry is not settled yet: retry later. */
export const EVIDENCE_NOT_READY = "EVIDENCE_NOT_READY";
const EVIDENCE_IMPORT_CONCURRENCY = 4;

/** SP's evidence file limit bounds every exported file, trajectory parts included, so import never rejects a stored bundle. */
export function spEvidenceLimits(limits: EvidenceLimits): EvidenceLimits {
  return { ...limits, maxFileBytes: Math.min(limits.maxFileBytes, EVAL_EVIDENCE_FILE_MAX_BYTES) };
}

export interface SpHarnessOptions {
  readonly origin: string;
  readonly serviceToken: string;
  readonly fetch?: Fetch;
  readonly requestTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /** Bound for one streamed resource snapshot or evidence transfer; defaults to five minutes. */
  readonly transferTimeoutMs?: number;
  /** JSON response ceiling; defaults to, and may not exceed, {@link MAX_JSON_RESPONSE_BYTES}. */
  readonly maxResponseBytes?: number;
  readonly openWebSocket?: OpenWebSocket;
  /** Payload-free diagnostics for WebSocket observation, resource reads and evidence transfers. */
  readonly log?: RuntimeLog;
  readonly resolveInitialMaterials?: (
    ownerUserId: string,
    reference: InitialMaterialsRef,
  ) => Promise<readonly MaterialFile[]>;
  readonly resolveInitialSession?: (
    ownerUserId: string,
    reference: InitialSessionRef,
  ) => Promise<SessionContent>;
}

/** The SP Harness drives only SP Agents; any other framework is rejected before contacting SP. */
function requireSp(framework: AgentFramework): void {
  if (framework !== "sp") throw new SpHarnessError(`SP Harness cannot run ${framework} Agents`, false);
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

interface FailureContext {
  /** What was read, for an explicit size-limit message. */
  readonly label?: string;
  readonly maxResponseBytes: number;
  /** A GET of an evidence route, where `409 EVIDENCE_NOT_READY` means "read again later". */
  readonly evidenceRead?: boolean;
}

function evidenceNotReady(status: number, code: string | undefined, context: Pick<FailureContext, "evidenceRead">): boolean {
  return context.evidenceRead === true && status === 409 && code === EVIDENCE_NOT_READY;
}

/** Harness operations are idempotent, so every transient SP failure may be retried. */
function harnessError(error: unknown, context: FailureContext): unknown {
  if (isRequestCancelled(error)) return error;
  if (!(error instanceof ApiError)) return error;
  if (error.code === "RESPONSE_TOO_LARGE") {
    // Repeating the read returns the same body; only a larger ceiling or a smaller response can succeed.
    return new SpHarnessError(`Eval SP ${context.label ?? "response"} exceeded the ${context.maxResponseBytes}-byte response limit`,
      false, { cause: error });
  }
  const transient = error.kind === "network" || error.kind === "timeout"
    || (error.kind === "http" && (transientStatus(error.status) || evidenceNotReady(error.status, error.code, context)));
  return new SpHarnessError(error.kind === "http" ? error.message : `Eval SP request failed: ${error.code}`,
    transient, {
      ...(error.kind === "http" ? { status: error.status } : {}),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      cause: error,
    });
}

/** The error envelope of a rejected byte request, when it is small JSON. */
async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(await readBytesLimited(response, ERROR_BODY_BYTES)));
  } catch {
    return undefined;
  }
}

/** Passes bytes through unchanged while proving they are exactly the manifest's size and SHA-256. */
function verifiedStream(source: ReadableStream<Uint8Array>, size: number, sha256: string,
  mismatch: () => SpHarnessError): ReadableStream<Uint8Array> {
  const hash = createHash("sha256");
  let received = 0;
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > size) throw mismatch();
      hash.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      if (received !== size || hash.digest("hex") !== sha256) throw mismatch();
    },
  }));
}

export function createSpHarness(options: SpHarnessOptions): Harness {
  const origin = httpOriginSchema.parse(options.origin);
  if (!options.serviceToken) throw new TypeError("Eval SP service token is required");
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const transferTimeoutMs = options.transferTimeoutMs ?? Math.max(TRANSFER_TIMEOUT_MS, requestTimeoutMs);
  if (![requestTimeoutMs, stopTimeoutMs, transferTimeoutMs].every((timeout) => Number.isFinite(timeout) && timeout > 0)) {
    throw new TypeError("Eval SP request timeouts must be positive finite numbers");
  }
  const maxResponseBytes = options.maxResponseBytes ?? MAX_JSON_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > MAX_JSON_RESPONSE_BYTES) {
    throw new TypeError(`Eval SP response limit must be a positive integer of at most ${MAX_JSON_RESPONSE_BYTES} bytes`);
  }
  const log = safeLog(options.log);
  const serviceHeaders = { [EVAL_SERVICE_HEADER]: options.serviceToken };
  const fetchSp = options.fetch ?? globalThis.fetch;
  const http = createSpHttpClient({
    origin,
    responseMode: "json",
    timeoutMs: requestTimeoutMs,
    maxResponseBytes,
    headers: serviceHeaders,
    fetch: options.fetch,
  });
  const openWebSocket = options.openWebSocket
    ?? ((url: string, headers: Readonly<Record<string, string>>) => new WebSocket(url, { headers }));

  interface CallOptions {
    readonly body?: unknown;
    readonly timeoutMs?: number;
    readonly label?: string;
    readonly evidenceRead?: boolean;
    readonly signal?: AbortSignal;
    readonly maxResponseBytes?: number;
  }

  async function call(method: "GET" | "POST" | "PUT", path: string, request: CallOptions = {}): Promise<unknown> {
    const { body, timeoutMs, signal } = request;
    try {
      return (await http.request<unknown>(path, {
        method,
        ...(body === undefined ? {} : { body }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(signal === undefined ? {} : { signal }),
        ...(request.maxResponseBytes === undefined ? {} : { maxResponseBytes: request.maxResponseBytes }),
      })).data;
    } catch (error) {
      throw harnessError(error, {
        maxResponseBytes: request.maxResponseBytes ?? maxResponseBytes,
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(request.evidenceRead === undefined ? {} : { evidenceRead: request.evidenceRead }),
      });
    }
  }

  /** Evidence file bytes are streamed both ways; `failure` names an integrity error that aborted the upload. */
  async function callBytes(method: "GET" | "PUT", path: string, init: {
    readonly body?: Uint8Array | ReadableStream<Uint8Array>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly failure?: () => SpHarnessError | undefined;
    readonly signal?: AbortSignal;
  } = {}): Promise<Response> {
    let response: Response;
    const { body } = init;
    try {
      if (init.signal?.aborted) throw init.signal.reason;
      response = await fetchSp(new URL(path, origin), {
        method,
        redirect: "error",
        signal: init.signal === undefined
          ? AbortSignal.timeout(transferTimeoutMs)
          : AbortSignal.any([init.signal, AbortSignal.timeout(transferTimeoutMs)]),
        headers: { ...serviceHeaders, ...init.headers },
        ...(body === undefined ? {} : body instanceof ReadableStream
          // Node's fetch streams a request body only in half-duplex mode.
          ? { body, duplex: "half" } as RequestInit
          : { body: new Uint8Array(body) }),
      });
    } catch (cause) {
      if (init.signal?.aborted || isRequestCancelled(cause)) throw cause;
      throw init.failure?.() ?? new SpHarnessError("Eval SP evidence request failed", true, { cause });
    }
    if (!response.ok) {
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => { headers[name] = value; });
      const parsed = parseHttpError(await readErrorBody(response), { status: response.status, headers });
      const notReady = evidenceNotReady(response.status, parsed.code, { evidenceRead: method === "GET" });
      const requestId = headers["x-request-id"];
      const cfRay = headers["cf-ray"];
      throw new SpHarnessError(`Eval SP evidence request returned ${response.status} (${parsed.code})`,
        notReady || transientStatus(response.status), {
          status: response.status,
          ...(parsed.retryAfterMs === undefined ? {} : { retryAfterMs: parsed.retryAfterMs }),
          ...(requestId === undefined ? {} : { requestId }),
          ...(cfRay === undefined ? {} : { cfRay }),
        });
    }
    return response;
  }

  /** Identifiers only: never prompts, payloads, events or credentials. */
  const handleContext = (handle: AgentHandle): Record<string, string> => ({
    role: handle.role,
    chatId: handle.chatId,
    samplingId: handle.samplingId,
    ...(handle.evaluationId === undefined ? {} : { evaluationId: handle.evaluationId }),
  });
  const failureFields = (error: unknown) => ({
    error: errorDiagnostics(error) ?? String(error),
    ...(error instanceof SpHarnessError ? {
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(error.cfRay === undefined ? {} : { cfRay: error.cfRay }),
    } : {}),
  });

  const chatPath = (ownerUserId: string, chatId: string): string =>
    `${EVAL_HARNESS_PATH}/users/${encodeURIComponent(ownerUserId)}/chats/${encodeURIComponent(chatId)}`;
  const handlePath = (handle: AgentHandle): string => chatPath(handle.ownerUserId, handle.chatId);
  const operationPath = (kind: "submissions" | "resources", handle: AgentHandle, key: string): string =>
    `${handlePath(handle)}/${kind}/by-key/${encodeURIComponent(key)}`;

  function assertNativeChat(entry: NativeTrajectoryEntry, chatId: string): void {
    if (entry.record.resource.sessionId !== chatId
      || (entry.record.parent !== undefined
        && (entry.record.parent.resource as { readonly sessionId: string }).sessionId !== chatId)) {
      throw new SpHarnessError("Eval SP returned a trajectory record outside the requested Chat", false);
    }
  }

  /** References describe one complete JSONL record, not permission to split a record across files. */
  function assertRecordReference(reference: SpPiTrajectoryRecordReference, chatId: string): void {
    if (spPiTrajectoryIdentityParts(reference.reference.identity)?.[1] !== chatId) {
      throw new SpHarnessError("Eval SP returned a trajectory record outside the requested Chat", false);
    }
    const framing = Buffer.byteLength(`{"ingestSeq":${reference.ingestSeq},"record":}\n`);
    if (reference.reference.byteLength + framing > EVAL_EVIDENCE_FILE_MAX_BYTES) {
      throw new SpHarnessError("Eval SP native trajectory record exceeds one evidence file", false);
    }
  }

  /** Fetch exactly one original SAFE Pi record through SP's public service-authenticated byte route. */
  async function transferNativeRecord(
    handle: AgentHandle,
    submissionId: string,
    row: SpPiTrajectoryRecordReference,
    signal?: AbortSignal,
  ): Promise<NativeTrajectoryEntry> {
    assertRecordReference(row, handle.chatId);
    const { reference } = row;
    const fields = { ...handleContext(handle), submissionId, ingestSeq: row.ingestSeq, bytes: reference.byteLength };
    const path = `${handlePath(handle)}/evidence/trajectory/records/${row.ingestSeq}?${new URLSearchParams({
      submissionId, throughSeq: String(reference.throughSeq), identity: reference.identity,
      byteLength: String(reference.byteLength), sha256: reference.sha256,
    })}`;
    try {
      const response = await callBytes("GET", path, { ...(signal === undefined ? {} : { signal }) });
      const mismatch = () => new SpHarnessError("Eval SP native trajectory record transfer differs from its reference", false);
      if (response.headers.get("Content-Type")?.toLowerCase().replaceAll(" ", "") !== "application/json;charset=utf-8"
        || response.headers.get("Content-Length") !== String(reference.byteLength)
        || response.headers.get(EVAL_EVIDENCE_SHA256_HEADER) !== reference.sha256
        || response.headers.get(SP_PI_TRAJECTORY_RECORD_IDENTITY_HEADER) !== encodeURIComponent(reference.identity)
        || response.headers.get(SP_PI_TRAJECTORY_RECORD_INGEST_SEQ_HEADER) !== String(row.ingestSeq)
        || response.headers.get(SP_PI_TRAJECTORY_RECORD_THROUGH_SEQ_HEADER) !== String(reference.throughSeq)
        || !response.body) {
        await response.body?.cancel();
        throw mismatch();
      }
      const reader = response.body.getReader();
      const timeout = AbortSignal.timeout(transferTimeoutMs);
      const bodySignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      const abort = () => { void reader.cancel(bodySignal.reason).catch(() => undefined); };
      bodySignal.addEventListener("abort", abort, { once: true });
      const hash = createHash("sha256");
      const chunks: Uint8Array[] = [];
      let received = 0;
      let finished = false;
      try {
        while (true) {
          if (bodySignal.aborted) break;
          const part = await reader.read();
          if (part.done) break;
          received += part.value.byteLength;
          if (received > reference.byteLength) throw mismatch();
          hash.update(part.value);
          chunks.push(part.value);
        }
        if (signal?.aborted) throw signal.reason;
        if (timeout.aborted) throw new SpHarnessError("Eval SP native trajectory record transfer timed out", true);
        if (received !== reference.byteLength || hash.digest("hex") !== reference.sha256) throw mismatch();
        finished = true;
      } catch (cause) {
        if (signal?.aborted) throw signal.reason;
        if (cause instanceof SpHarnessError || isRequestCancelled(cause)) throw cause;
        throw new SpHarnessError("Eval SP native trajectory record stream failed", true, { cause });
      } finally {
        bodySignal.removeEventListener("abort", abort);
        if (!finished) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      let parsed: unknown;
      try {
        const body = Buffer.allocUnsafe(received);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body));
      } catch {
        throw mismatch();
      }
      const native = nativeTrajectoryEntrySchema.safeParse({ ingestSeq: row.ingestSeq, record: parsed });
      if (!native.success || spPiTrajectoryRecordIdentity(native.data.record) !== reference.identity) throw mismatch();
      assertNativeChat(native.data, handle.chatId);
      log({ name: "evidence_trajectory_record", ...fields, status: 200 });
      return native.data;
    } catch (error) {
      if (isRequestCancelled(error)) throw error;
      log({ name: "evidence_trajectory_record", ...fields, ...failureFields(error) });
      throw error;
    }
  }

  /** Complete safe Pi records of this Chat, bounded at one frozen SP high-water mark.
   * The Submission authorizes the read, not a filter on Context or earlier Submissions.
   * A resumed evidence export passes its saved mark instead of adopting later records. */
  async function* trajectoryRecords(
    handle: AgentHandle, submissionId: string, from = 0, frozenThroughSeq?: number,
  ): AsyncGenerator<NativeTrajectoryEntry & { readonly throughSeq: number }> {
    if (!Number.isSafeInteger(from) || from < 0) throw new SpHarnessError(`Invalid trajectory cursor ${from}`, false);
    if (!submissionId || (frozenThroughSeq !== undefined
      && (!Number.isSafeInteger(frozenThroughSeq) || frozenThroughSeq < from))) {
      throw new SpHarnessError("Invalid trajectory Submission or frozen watermark", false);
    }
    const path = `${handlePath(handle)}/evidence/trajectory`;
    let afterSeq: number | null = from;
    let throughSeq = frozenThroughSeq;
    let pages = 0;
    let records = 0;
    while (afterSeq !== null) {
      const query = new URLSearchParams({
        afterSeq: String(afterSeq), limit: String(EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX), submissionId,
        ...(throughSeq === undefined ? {} : { throughSeq: String(throughSeq) }),
      });
      const fields = { ...handleContext(handle), afterSeq, submissionId };
      let page: ReturnType<typeof evidenceTrajectoryPage>;
      try {
        page = evidenceTrajectoryPage(await call("GET", `${path}?${query}`,
          { timeoutMs: transferTimeoutMs, label: "evidence trajectory page", evidenceRead: true,
            maxResponseBytes: Math.min(maxResponseBytes, MAX_TRAJECTORY_PAGE_BYTES) }));
      } catch (error) {
        log({ name: "evidence_trajectory_page", ...fields, ...failureFields(error) });
        throw error;
      }
      if (page.records.length > EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX || page.cursor.throughSeq < afterSeq
        || (throughSeq !== undefined && page.cursor.throughSeq !== throughSeq)) {
        throw new SpHarnessError("Eval SP changed the trajectory watermark or exceeded the page limit", false);
      }
      throughSeq = page.cursor.throughSeq;
      pages += 1;
      records += page.records.length;
      let last: number = afterSeq;
      for (const row of page.records) {
        if (row.ingestSeq <= last || row.ingestSeq > throughSeq) {
          throw new SpHarnessError("Eval SP trajectory records are out of order or beyond the watermark", false);
        }
        // The public evidence page carries the full Chat keyset. Validate each safe native
        // inline record's Chat or reference identity before yielding any part of this page.
        // Evidence is not filtered to the selected Submission.
        if (isSpPiTrajectoryReference(row)) assertRecordReference(row, handle.chatId);
        else assertNativeChat(row, handle.chatId);
        last = row.ingestSeq;
      }
      if (page.nextAfterSeq !== null && (page.records.length === 0 || page.nextAfterSeq !== last || last >= throughSeq)) {
        throw new SpHarnessError("Eval SP returned an invalid trajectory cursor", false);
      }
      // Reject contradictory page metadata before yielding; byte references are then verified
      // one at a time. A failed transfer cannot finalize evidence or mislabel a partial record.
      for (const row of page.records) {
        const entry = isSpPiTrajectoryReference(row) ? await transferNativeRecord(handle, submissionId, row) : row;
        yield { ...entry, throughSeq };
      }
      if (page.nextAfterSeq === null) log({ name: "evidence_trajectory_page", ...fields, status: 200, from, pages, records });
      afterSeq = page.nextAfterSeq;
    }
  }

  async function inspect(handle: AgentHandle, idempotencyKey: string): Promise<AgentSubmission | null> {
    let value: unknown;
    try {
      value = await call("GET", operationPath("submissions", handle, idempotencyKey));
    } catch (error) {
      if (error instanceof SpHarnessError && error.status === 404) throw new AgentHandleNotFoundError(handle.chatId);
      throw error;
    }
    return value === null ? null : submission(value);
  }

  /** A known Submission; SP answers 404 only when it or its Chat no longer exists. */
  async function inspectKnown(handle: AgentHandle, submissionId: string): Promise<AgentSubmission> {
    try {
      return submission(await call("GET", `${handlePath(handle)}/submissions/${encodeURIComponent(submissionId)}`));
    } catch (error) {
      if (error instanceof SpHarnessError && error.status === 404) throw new AgentHandleNotFoundError(handle.chatId);
      throw error;
    }
  }

  async function readResources<
    Wire extends { readonly finalized: boolean; readonly readiness?: AgentResourceReadiness },
    Output extends { readonly finalized: boolean; readonly readiness?: AgentResourceReadiness } = Wire,
  >(
    input: CollectAgentResourcesInput, name: string, leaf: string, parse: (value: unknown) => Wire, timeoutMs: number,
    summary: (value: Output) => Record<string, unknown> = () => ({}),
    hydrate?: (wire: Wire, submissionId: string) => Promise<Output>,
  ): Promise<Output> {
    requireSp(input.handle.framework);
    const bound = input.submissionId === undefined ? {} : { submissionId: input.submissionId };
    const query = input.submissionId === undefined ? "" : `?${new URLSearchParams(bound)}`;
    const started = Date.now();
    const fields = () => ({ ...handleContext(input.handle), idempotencyKey: input.idempotencyKey, ...bound, durationMs: Date.now() - started });
    let value: Output;
    try {
      const wire = parse(await call("GET", `${operationPath("resources", input.handle, input.idempotencyKey)}${leaf}${query}`,
        { timeoutMs, label: `resource ${leaf === "" ? "snapshot" : "readiness"}`,
          ...(input.signal === undefined ? {} : { signal: input.signal }) }));
      const scoped = wire as Wire & { readonly scope: { readonly chatId: string; readonly idempotencyKey: string; readonly submissionId: string } };
      if (scoped.scope.chatId !== input.handle.chatId || scoped.scope.idempotencyKey !== input.idempotencyKey
        || (input.submissionId !== undefined && scoped.scope.submissionId !== input.submissionId)) {
        throw new SpHarnessError("Eval SP returned resources for a different Chat or Submission", false);
      }
      value = hydrate ? await hydrate(wire, scoped.scope.submissionId) : wire as unknown as Output;
      const nativeRecords = (value as Output & { readonly nativeRecords?: readonly NativeTrajectoryEntry[] }).nativeRecords;
      for (const entry of nativeRecords ?? []) {
        assertNativeChat(entry, input.handle.chatId);
        if (!nativeRecordMayBelongToScope(entry.record, scoped.scope)) {
          throw new SpHarnessError("Eval SP returned a resource record outside the requested operation", false);
        }
      }
    } catch (error) {
      if (isRequestCancelled(error)) throw error;
      log({ name, ...fields(), ...failureFields(error) });
      throw error;
    }
    log({ name, ...fields(), status: 200, finalized: value.finalized, readiness: value.readiness, ...summary(value) });
    return value;
  }

  async function submit(input: SubmitAgentInput): Promise<AgentSubmission> {
    requireSp(input.handle.framework);
    return submission(await call("POST", `${handlePath(input.handle)}/submissions`, { body: submitRequest({
      idempotencyKey: input.idempotencyKey,
      prompt: input.prompt,
      unattended: true,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    }) }));
  }

  return {
    async ensureAgent(input) {
      requireSp(input.framework);
      const chat = ensureChatRequest(input);
      let value: unknown;
      try {
        value = await call("PUT", chatPath(chat.agentConfig.ownerUserId, chat.chatId), { body: chat });
      } catch (error) {
        if (error instanceof SpHarnessError && error.status === 409) throw new AgentIdentityConflictError(input.chatId);
        throw error;
      }
      return agentHandle(value, chat);
    },
    async materializeInitialData(input) {
      requireSp(input.handle.framework);
      if ((input.handle.role === "evaluator") !== (input.evaluationOutputSchema !== undefined)) {
        throw new SpHarnessError("Evaluation output JSON Schema must be supplied only for an Evaluator", false);
      }
      const { initialSession: session, initialMaterials: materials } = input.data;
      const { resolveInitialMaterials, resolveInitialSession } = options;
      if (materials && !resolveInitialMaterials) {
        throw new SpHarnessError("Initial material bundle resolver is required for this Sample", false);
      }
      if (session && !resolveInitialSession) {
        throw new SpHarnessError("Initial context bundle resolver is required for this Sample", false);
      }
      const [files, context] = await Promise.all([
        Promise.all((materials ?? []).map((material) => resolveInitialMaterials!(input.handle.ownerUserId, material))),
        session && resolveInitialSession!(input.handle.ownerUserId, session),
      ]);
      const body: EvalInitialization = {
        idempotencyKey: input.idempotencyKey,
        data: input.data,
        ...(session ? { initialSession: { ...session, ...(context ? { context } : {}) } } : {}),
        ...(materials ? { initialMaterials: materials.map((material, index) => ({ ...material, files: [...files[index]!] })) } : {}),
        ...(input.evaluationOutputSchema === undefined
          ? {} : { evaluationOutputSchema: { content: `${JSON.stringify(input.evaluationOutputSchema, null, 2)}\n` } }),
      };
      return dataBinding(await call("POST", `${handlePath(input.handle)}/initialization`, { body: initializationRequest(body) }));
    },
    submitAgent: submit,
    restartAgent: submit,
    inspectAgentOperation(input) {
      requireSp(input.handle.framework);
      return inspect(input.handle, input.idempotencyKey);
    },
    async stopAgent({ handle }) {
      requireSp(handle.framework);
      try {
        requireStopResult(await call("POST", `${handlePath(handle)}/submissions/stop`, { timeoutMs: stopTimeoutMs }));
      } catch (error) {
        if (error instanceof SpHarnessError && error.status === 404) return;
        throw error;
      }
    },
    async waitForSubmission(input) {
      requireSp(input.handle.framework);
      const current = await inspect(input.handle, input.idempotencyKey);
      if (!current) throw new SpHarnessError("Submission operation was not found", true);
      if (isTerminalAgentStatus(current.status)) return current;
      const timeoutMs = input.runtime?.timeoutMs;
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw new SpHarnessError("Submission timeout must be positive", false);
      }
      const url = new URL(`${handlePath(input.handle)}/submissions/${encodeURIComponent(current.submissionId)}/events`,
        origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return observeTerminalSubmission({
        open: () => openWebSocket(url.href, serviceHeaders),
        inspect: () => inspectKnown(input.handle, current.submissionId),
        current,
        timeoutMs,
        log,
        context: { ...handleContext(input.handle), idempotencyKey: input.idempotencyKey },
      });
    },
    async collectExecution({ handle }) {
      requireSp(handle.framework);
      if (handle.role !== "subject") throw new SpHarnessError("Expected Subject Chat", false);
      const query = new URLSearchParams({ role: handle.role, samplingId: handle.samplingId });
      return executionOutput(await call("GET", `${handlePath(handle)}/output?${query}`, { evidenceRead: true }), handle.samplingId);
    },
    async collectEvaluation({ handle }) {
      requireSp(handle.framework);
      if (handle.role !== "evaluator" || handle.evaluationId === undefined) {
        throw new SpHarnessError("Expected Evaluator Chat", false);
      }
      const query = new URLSearchParams({
        role: handle.role,
        samplingId: handle.samplingId,
        evaluationId: handle.evaluationId,
      });
      return evaluationOutput(await call("GET", `${handlePath(handle)}/output?${query}`, { evidenceRead: true }));
    },
    async readFinalReply({ handle, submissionId }) {
      requireSp(handle.framework);
      let reply: string | undefined;
      const scope = { chatId: handle.chatId, submissionId };
      for await (const { record } of trajectoryRecords(handle, submissionId)) {
        // The Chat page includes Context and other Submissions. Only this Submission's
        // own assistant entries can supply a final reply; child entries are also
        // excluded by finalReplyText's exact Submission check.
        if (!nativeRecordMayBelongToScope(record, scope)) continue;
        const candidate = finalReplyText(record, submissionId);
        if (candidate !== undefined) reply = candidate ?? undefined;
      }
      return reply;
    },
    collectAgentResources: (input) => readResources<SpResourceSnapshotWire, AgentResourceSnapshot>(
      input, "resources_read", "", resourceSnapshot, transferTimeoutMs,
      (snapshot) => ({ coverage: snapshot.coverage, usageEvents: snapshot.usageEvents.length,
        nativeRecords: snapshot.nativeRecords.length, billingSettlements: snapshot.billingSettlements.length }),
      async (wire, submissionId) => {
        const nativeRecords: NativeTrajectoryEntry[] = [];
        for (const row of wire.nativeRecords) {
          const entry = isSpPiTrajectoryReference(row)
            ? await transferNativeRecord(input.handle, submissionId, row, input.signal) : row;
          assertNativeChat(entry, input.handle.chatId);
          if (!nativeRecordMayBelongToScope(entry.record, wire.scope)) {
            throw new SpHarnessError("Eval SP returned a resource record outside the requested operation", false);
          }
          nativeRecords.push(entry);
        }
        // Runtime and Metrics retain complete raw facts, never public transfer references.
        return { ...wire, nativeRecords };
      }),
    inspectAgentResources: (input) => readResources(input, "resources_readiness", "/readiness", resourceReadiness, requestTimeoutMs),
    async exportEvidence({ handle, submissionId, limits, initialMaterials }) {
      requireSp(handle.framework);
      if (handle.role !== "subject") throw new SpHarnessError("Only a Subject exports evidence", false);
      if (initialMaterials?.length && !options.resolveInitialMaterials) {
        throw new SpHarnessError("Initial material bundle resolver is required for Subject input evidence", false);
      }
      const subjectInputs = (await Promise.all((initialMaterials ?? []).map(async (reference) => {
        const files = await options.resolveInitialMaterials!(handle.ownerUserId, reference);
        return files.map(({ path, mediaType, contentBase64 }) => {
          const bytes = new Uint8Array(Buffer.from(contentBase64, "base64"));
          return { ...reference, path, mediaType, size: bytes.byteLength, read: async () => new Response(bytes).body! };
        });
      }))).flat();
      const path = `${handlePath(handle)}/evidence`;
      const bound = { submissionId };
      const listed = evidenceArtifacts(await call("GET", `${path}/artifacts?${new URLSearchParams(bound)}`,
        { timeoutMs: transferTimeoutMs, label: "evidence artifact list", evidenceRead: true }));
      const { artifacts, omitted } = applyEvidenceLimits(listed, spEvidenceLimits(limits));
      return {
        source: { framework: "sp", samplingId: handle.samplingId, agentRef: { ownerUserId: handle.ownerUserId, chatId: handle.chatId } },
        artifacts,
        subjectInputs,
        omitted,
        async readFile(file) {
          const fields = { ...handleContext(handle), ...bound, direction: "read", path: file };
          let response: Response;
          try {
            response = await callBytes("GET", `${path}/files?${new URLSearchParams({ path: file, ...bound })}`);
          } catch (error) {
            log({ name: "evidence_file", ...fields, ...failureFields(error) });
            throw error;
          }
          if (!response.body) throw new SpHarnessError(`Eval SP returned no bytes for ${file}`, true);
          return response.body;
        },
        async* readTrajectory(afterSeq, throughSeq) {
          // Source identity and native record are unchanged in the JSONL line. Only the frozen
          // high-water mark is additional local progress metadata, never part of that line.
          for await (const entry of trajectoryRecords(handle, submissionId, afterSeq, throughSeq)) {
            yield { seq: entry.ingestSeq, throughSeq: entry.throughSeq,
              record: { ingestSeq: entry.ingestSeq, record: entry.record } as unknown as JsonValue };
          }
        },
        trajectoryFormat: SP_PI_TRAJECTORY_FORMAT,
        // SP exposes native records only after the Submission ended and its deliveries settled.
        trajectoryComplete: true,
      };
    },
    async importEvidence({ handle, evidence }) {
      requireSp(handle.framework);
      if (handle.role !== "evaluator") throw new SpHarnessError("Only an Evaluator imports evidence", false);
      const { manifest } = evidence;
      if (manifest.schemaVersion !== EVIDENCE_SCHEMA_VERSION
        || manifest.trajectory.format !== SP_PI_TRAJECTORY_FORMAT || !manifest.trajectory.complete) {
        throw new SpHarnessError("Cannot import a non-native or unsupported evidence manifest", false);
      }
      /** Streams one stored blob to SP; SP checks the SHA-256 header and both sides compare the receipt. */
      const put = async (relative: string, mediaType: string, sha256: string, size: number,
        read: () => Promise<ReadableStream<Uint8Array> | Uint8Array>) => {
        let failure: SpHarnessError | undefined;
        const mismatch = () => failure ??= new SpHarnessError(`Evidence bytes do not match the import contract for ${relative}`, false);
        const source = await read();
        if (source instanceof Uint8Array
          && (source.byteLength !== size || createHash("sha256").update(source).digest("hex") !== sha256)) throw mismatch();
        const fields = { ...handleContext(handle), direction: "write", path: relative, bytes: size };
        let response: Response;
        try {
          response = await callBytes("PUT", `${handlePath(handle)}/evidence/files?${new URLSearchParams({ path: relative })}`, {
            body: source instanceof Uint8Array ? source : verifiedStream(source, size, sha256, mismatch),
            headers: { "Content-Type": mediaType, [EVAL_EVIDENCE_SHA256_HEADER]: sha256 },
            failure: () => failure,
          });
        } catch (error) {
          log({ name: "evidence_file", ...fields, ...failureFields(error) });
          throw error;
        }
        const receipt = evidenceFileReceipt(await response.json());
        if (failure) throw failure;
        if (receipt.path !== evalEvidencePath(relative) || receipt.sha256 !== sha256 || receipt.size !== size) {
          throw new SpHarnessError(`Eval SP stored different evidence for ${relative}`, false);
        }
      };
      const blob = (sha256: string) => () => evidence.readBlob(sha256);
      const planned = [
        ...manifest.subjectInputs.map((file) => ({ relative: evalSubjectInputEvidencePath(file.bundleId, file.materialId, file.path),
          mediaType: file.mediaType, sha256: file.sha256, size: file.size })),
        ...manifest.artifacts.map((artifact) => ({ relative: evalArtifactEvidencePath(artifact.path),
          mediaType: artifact.mediaType, sha256: artifact.sha256, size: artifact.size })),
        ...manifest.trajectory.parts.map((part, index) => ({ relative: evalTrajectoryEvidencePath(index + 1),
          mediaType: "application/x-ndjson", sha256: part.sha256, size: part.size })),
      ];
      // Export already keeps every file within `spEvidenceLimits`; a bundle stored under larger limits
      // fails explicitly before any write instead of leaving a partial bundle.
      for (const file of planned) {
        if (file.size > EVAL_EVIDENCE_FILE_MAX_BYTES) {
          throw new SpHarnessError(`Evidence file ${file.relative} is ${file.size} bytes, above SP's ${EVAL_EVIDENCE_FILE_MAX_BYTES}-byte evidence file limit; the bundle cannot be imported`, false);
        }
      }
      const files = planned.map((file) => () => put(file.relative, file.mediaType, file.sha256, file.size, blob(file.sha256)));
      const started = Date.now();
      let next = 0;
      let stored = 0;
      const summary = () => ({
        name: "evidence_import", ...handleContext(handle), evidenceId: evidence.ref.evidenceId, filesStored: stored,
        filesTotal: planned.length + 1, bytes: planned.reduce((sum, { size }) => sum + size, evidence.manifestBytes.byteLength),
        durationMs: Date.now() - started,
      });
      try {
        await Promise.all(Array.from({ length: Math.min(EVIDENCE_IMPORT_CONCURRENCY, files.length) }, async () => {
          while (next < files.length) {
            await files[next++]!();
            stored += 1;
          }
        }));
        // The manifest goes last, so its presence means every file it lists is already in place.
        await put(EVAL_EVIDENCE_PATHS.manifest, "application/json", evidence.ref.manifestSha256, evidence.manifestBytes.byteLength,
          async () => evidence.manifestBytes);
        stored += 1;
      } catch (error) {
        log({ ...summary(), outcome: "failed", ...failureFields(error) });
        throw error;
      }
      log({ ...summary(), outcome: "stored" });
    },
  };
}
