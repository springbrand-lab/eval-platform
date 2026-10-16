import type { AgentFramework, JsonValue } from "@eval-platform/eval-contracts";
import { isTerminalAgentStatus } from "@eval-platform/eval-contracts";
import type { InitialMaterialsRef, InitialSessionRef } from "@eval-platform/eval-dataset";
import {
  AgentHandleNotFoundError,
  AgentIdentityConflictError,
  applyEvidenceLimits,
  type AgentHandle,
  type AgentSubmission,
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
import { ApiError } from "@springbrand/http/client";
import WebSocket from "ws";
import { sha256Hex } from "@eval-platform/eval-contracts";
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
  resourceSnapshot,
  requireStopResult,
  submission,
  submitRequest,
} from "./harness-wire.js";
import { createSpHttpClient, type Fetch } from "./http.js";
import { observeTerminalSubmission, type OpenWebSocket } from "./submission-observer.js";

export { SpHarnessError } from "./harness-error.js";

const REQUEST_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
/** Resource snapshots carry every telemetry event of a Submission. */
const RESPONSE_BYTES = 256 * 1024 * 1024;
const EVIDENCE_IMPORT_CONCURRENCY = 4;

export interface SpHarnessOptions {
  readonly origin: string;
  readonly serviceToken: string;
  readonly fetch?: Fetch;
  readonly requestTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly openWebSocket?: OpenWebSocket;
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

/** Harness operations are idempotent, so every transient SP failure may be retried. */
function harnessError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  const transient = error.kind === "network" || error.kind === "timeout"
    || (error.kind === "http" && transientStatus(error.status));
  return new SpHarnessError(error.kind === "http" ? error.message : `Eval SP request failed: ${error.code}`,
    transient, { ...(error.kind === "http" ? { status: error.status } : {}), cause: error });
}

export function createSpHarness(options: SpHarnessOptions): Harness {
  const origin = httpOriginSchema.parse(options.origin);
  if (!options.serviceToken) throw new TypeError("Eval SP service token is required");
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0
    || !Number.isFinite(stopTimeoutMs) || stopTimeoutMs <= 0) {
    throw new TypeError("Eval SP request timeouts must be positive finite numbers");
  }
  const serviceHeaders = { [EVAL_SERVICE_HEADER]: options.serviceToken };
  const http = createSpHttpClient({
    origin,
    responseMode: "json",
    timeoutMs: requestTimeoutMs,
    maxResponseBytes: RESPONSE_BYTES,
    headers: serviceHeaders,
    fetch: options.fetch,
  });
  const openWebSocket = options.openWebSocket
    ?? ((url: string, headers: Readonly<Record<string, string>>) => new WebSocket(url, { headers }));

  async function call(method: "GET" | "POST" | "PUT", path: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    try {
      return (await http.request<unknown>(path, {
        method,
        ...(body === undefined ? {} : { body }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })).data;
    } catch (error) {
      throw harnessError(error);
    }
  }

  const fetchSp = options.fetch ?? globalThis.fetch;

  /** Evidence file bytes are not JSON; they share the origin, service token and timeouts. */
  async function callBytes(method: "GET" | "PUT", path: string, init: {
    readonly body?: Uint8Array;
    readonly headers?: Readonly<Record<string, string>>;
  } = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetchSp(new URL(path, origin), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { ...serviceHeaders, ...init.headers },
        ...(init.body === undefined ? {} : { body: new Uint8Array(init.body) }),
      });
    } catch (cause) {
      throw new SpHarnessError("Eval SP evidence request failed", true, { cause });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SpHarnessError(`Eval SP evidence request returned ${response.status}`, transientStatus(response.status),
        { status: response.status });
    }
    return response;
  }

  const chatPath = (ownerUserId: string, chatId: string): string =>
    `${EVAL_HARNESS_PATH}/users/${encodeURIComponent(ownerUserId)}/chats/${encodeURIComponent(chatId)}`;
  const handlePath = (handle: AgentHandle): string => chatPath(handle.ownerUserId, handle.chatId);
  const operationPath = (kind: "submissions" | "resources", handle: AgentHandle, key: string): string =>
    `${handlePath(handle)}/${kind}/by-key/${encodeURIComponent(key)}`;

  /** Every trajectory event of one Chat, oldest first; SP serves it only after the last Submission is terminal. */
  async function* trajectoryEvents(handle: AgentHandle): AsyncGenerator<{ ingestSeq: number; event: Record<string, JsonValue> }> {
    const path = `${handlePath(handle)}/evidence/trajectory`;
    let afterSeq: number | null = 0;
    while (afterSeq !== null) {
      const query = new URLSearchParams({ afterSeq: String(afterSeq), limit: String(EVAL_EVIDENCE_TRAJECTORY_PAGE_MAX) });
      const page = evidenceTrajectoryPage(await call("GET", `${path}?${query}`));
      let last: number = afterSeq;
      for (const event of page.events) {
        if (event.ingestSeq <= last) throw new SpHarnessError("Eval SP trajectory events are out of order", false);
        yield event;
        last = event.ingestSeq;
      }
      if (page.nextAfterSeq !== null && (page.events.length === 0 || page.nextAfterSeq !== last)) {
        throw new SpHarnessError("Eval SP returned an invalid trajectory cursor", false);
      }
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

  async function submit(input: SubmitAgentInput): Promise<AgentSubmission> {
    requireSp(input.handle.framework);
    return submission(await call("POST", `${handlePath(input.handle)}/submissions`, submitRequest({
      idempotencyKey: input.idempotencyKey,
      prompt: input.prompt,
      unattended: true,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    })));
  }

  return {
    async ensureAgent(input) {
      requireSp(input.framework);
      const chat = ensureChatRequest(input);
      let value: unknown;
      try {
        value = await call("PUT", chatPath(chat.agentConfig.ownerUserId, chat.chatId), chat);
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
      return dataBinding(await call("POST", `${handlePath(input.handle)}/initialization`, initializationRequest(body)));
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
        requireStopResult(await call("POST", `${handlePath(handle)}/submissions/stop`, undefined, stopTimeoutMs));
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
        inspect: () => inspect(input.handle, input.idempotencyKey),
        current,
        timeoutMs,
      });
    },
    async collectExecution({ handle }) {
      requireSp(handle.framework);
      if (handle.role !== "subject") throw new SpHarnessError("Expected Subject Chat", false);
      const query = new URLSearchParams({ role: handle.role, samplingId: handle.samplingId });
      return executionOutput(await call("GET", `${handlePath(handle)}/output?${query}`), handle.samplingId);
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
      return evaluationOutput(await call("GET", `${handlePath(handle)}/output?${query}`));
    },
    async readFinalReply({ handle }) {
      requireSp(handle.framework);
      let reply: string | undefined;
      for await (const { event } of trajectoryEvents(handle)) reply = finalReplyText(event) ?? reply;
      return reply;
    },
    async collectAgentResources(input) {
      requireSp(input.handle.framework);
      const query = input.submissionId === undefined ? "" : `?${new URLSearchParams({ submissionId: input.submissionId })}`;
      return resourceSnapshot(await call("GET", `${operationPath("resources", input.handle, input.idempotencyKey)}${query}`));
    },
    async exportEvidence({ handle, limits, initialMaterials }) {
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
      const listed = evidenceArtifacts(await call("GET", `${path}/artifacts`));
      // One SP file crosses one Durable Object RPC, so SP's own file limit bounds the plan's.
      const { artifacts, omitted } = applyEvidenceLimits(listed, {
        ...limits, maxFileBytes: Math.min(limits.maxFileBytes, EVAL_EVIDENCE_FILE_MAX_BYTES),
      });
      return {
        source: { framework: "sp", samplingId: handle.samplingId, agentRef: { ownerUserId: handle.ownerUserId, chatId: handle.chatId } },
        artifacts,
        subjectInputs,
        omitted,
        async readFile(file) {
          const response = await callBytes("GET", `${path}/files?${new URLSearchParams({ path: file })}`);
          if (!response.body) throw new SpHarnessError(`Eval SP returned no bytes for ${file}`, true);
          return response.body;
        },
        trajectory: trajectoryEvents(handle),
        trajectoryFormat: "sp-trajectory/v1",
        // SP reads `trajectory_events` only after the Submission ended and every event was delivered.
        trajectoryComplete: true,
      };
    },
    async importEvidence({ handle, evidence }) {
      requireSp(handle.framework);
      if (handle.role !== "evaluator") throw new SpHarnessError("Only an Evaluator imports evidence", false);
      const { manifest } = evidence;
      const put = async (relative: string, mediaType: string, sha256: string, read: () => Promise<Uint8Array>) => {
        const body = await read();
        if (body.byteLength > EVAL_EVIDENCE_FILE_MAX_BYTES || await sha256Hex(body) !== sha256) {
          throw new SpHarnessError(`Evidence bytes do not match the import contract for ${relative}`, false);
        }
        const receipt = evidenceFileReceipt(await (await callBytes("PUT",
          `${handlePath(handle)}/evidence/files?${new URLSearchParams({ path: relative })}`,
          { body, headers: { "Content-Type": mediaType, [EVAL_EVIDENCE_SHA256_HEADER]: sha256 } })).json());
        if (receipt.path !== evalEvidencePath(relative) || receipt.sha256 !== sha256 || receipt.size !== body.byteLength) {
          throw new SpHarnessError(`Eval SP stored different evidence for ${relative}`, false);
        }
      };
      const blob = (sha256: string) => async () => new Uint8Array(await new Response(await evidence.readBlob(sha256)).arrayBuffer());
      const files = [
        ...manifest.subjectInputs.map((file) => () => put(evalSubjectInputEvidencePath(file.bundleId, file.materialId, file.path), file.mediaType,
          file.sha256, blob(file.sha256))),
        ...manifest.artifacts.map((artifact) => () => put(evalArtifactEvidencePath(artifact.path), artifact.mediaType,
          artifact.sha256, blob(artifact.sha256))),
        ...manifest.trajectory.parts.map((part, index) => () => put(evalTrajectoryEvidencePath(index + 1),
          "application/x-ndjson", part.sha256, blob(part.sha256))),
      ];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(EVIDENCE_IMPORT_CONCURRENCY, files.length) }, async () => {
        while (next < files.length) await files[next++]!();
      }));
      // The manifest goes last, so its presence means every file it lists is already in place.
      await put(EVAL_EVIDENCE_PATHS.manifest, "application/json", evidence.ref.manifestSha256, async () => evidence.manifestBytes);
    },
  };
}
