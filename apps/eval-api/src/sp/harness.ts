import type { AgentFramework, EvaluationOutputSchema } from "@eval-platform/eval-contracts";
import { isTerminalAgentStatus } from "@eval-platform/eval-contracts";
import type { InitialMaterialsRef, InitialSessionRef } from "@eval-platform/eval-dataset";
import {
  AgentHandleNotFoundError,
  AgentIdentityConflictError,
  type AgentHandle,
  type AgentSubmission,
  type Harness,
  type SubmitAgentInput,
} from "@eval-platform/eval-runtime/harness";
import {
  EVAL_HARNESS_PATH,
  EVAL_SERVICE_HEADER,
  type EvalInitialization,
} from "@springbrand/eval-harness";
import { ApiError } from "@springbrand/http/client";
import WebSocket from "ws";
import { sha256Hex } from "@eval-platform/eval-contracts";
import { httpOriginSchema } from "../config/env.js";
import { EVALUATION_OUTPUT_SCHEMA_MATERIAL_PATH } from "../project-output-schema.js";
import type { MaterialFile, SessionContent } from "./bundle-directory.js";
import { SpHarnessError } from "./harness-error.js";
import {
  agentHandle,
  dataBinding,
  ensureChatRequest,
  evaluationOutput,
  executionOutput,
  initializationRequest,
  resourceSnapshot,
  requireStopResult,
  submission,
  submitRequest,
  trajectoryRequest,
} from "./harness-wire.js";
import { createSpHttpClient, type Fetch } from "./http.js";
import { observeTerminalSubmission, type OpenWebSocket } from "./submission-observer.js";

export { SpHarnessError } from "./harness-error.js";

const REQUEST_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
/** Resource snapshots carry every telemetry event of a Submission. */
const RESPONSE_BYTES = 256 * 1024 * 1024;
const OUTPUT_SCHEMA_BUNDLE_ID = "project-evaluation-output-schema";

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
  ) => Promise<SessionContent | undefined>;
}

/** The SP Harness drives only SP Agents; any other framework is rejected before contacting SP. */
function requireSp(framework: AgentFramework): void {
  if (framework !== "sp") throw new SpHarnessError(`SP Harness cannot run ${framework} Agents`, false);
}

/** Harness operations are idempotent, so every transient SP failure may be retried. */
function harnessError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  const transient = error.kind === "network" || error.kind === "timeout"
    || (error.kind === "http" && (error.status === 408 || error.status === 429 || error.status >= 500));
  return new SpHarnessError(error.kind === "http" ? error.message : `Eval SP request failed: ${error.code}`,
    transient, { ...(error.kind === "http" ? { status: error.status } : {}), cause: error });
}

function outputSchemaFile(schema: EvaluationOutputSchema): MaterialFile {
  return {
    path: EVALUATION_OUTPUT_SCHEMA_MATERIAL_PATH,
    mediaType: "application/schema+json",
    contentBase64: Buffer.from(`${JSON.stringify(schema, null, 2)}\n`, "utf8").toString("base64"),
  };
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

  const chatPath = (ownerUserId: string, chatId: string): string =>
    `${EVAL_HARNESS_PATH}/users/${encodeURIComponent(ownerUserId)}/chats/${encodeURIComponent(chatId)}`;
  const handlePath = (handle: AgentHandle): string => chatPath(handle.ownerUserId, handle.chatId);
  const operationPath = (kind: "submissions" | "resources", handle: AgentHandle, key: string): string =>
    `${handlePath(handle)}/${kind}/by-key/${encodeURIComponent(key)}`;

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
      const session = input.data.initialSession;
      const materials = input.data.initialMaterials;
      const { resolveInitialMaterials, resolveInitialSession } = options;
      if (materials && !resolveInitialMaterials) {
        throw new SpHarnessError("Initial material bundle resolver is required for this Sample", false);
      }
      const [files = [], context] = await Promise.all([
        materials && resolveInitialMaterials?.(input.handle.ownerUserId, materials),
        session && resolveInitialSession?.(input.handle.ownerUserId, session),
      ]);
      const schemaFile = input.evaluationOutputSchema === undefined
        ? undefined : outputSchemaFile(input.evaluationOutputSchema);
      if (schemaFile && files.some((file) => file.path === schemaFile.path)) {
        throw new SpHarnessError("Evaluator materials cannot overwrite the Project JSON Schema file", false);
      }
      const selectedMaterials = materials ?? (schemaFile && {
        bundleId: OUTPUT_SCHEMA_BUNDLE_ID,
        materialId: await sha256Hex(Buffer.from(schemaFile.contentBase64, "base64")),
      });
      const body: EvalInitialization = {
        idempotencyKey: input.idempotencyKey,
        data: materials || !selectedMaterials ? input.data : { ...input.data, initialMaterials: selectedMaterials },
        ...(session ? { initialSession: { ...session, ...(context ? { context } : {}) } } : {}),
        ...(selectedMaterials
          ? { initialMaterials: { ...selectedMaterials, files: schemaFile ? [...files, schemaFile] : [...files] } }
          : {}),
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
      if (handle.role !== "evaluator" || !handle.evaluationWorkspace) {
        throw new SpHarnessError("Expected Evaluator Chat", false);
      }
      const query = new URLSearchParams({
        role: handle.role,
        samplingId: handle.samplingId,
        evaluationId: handle.evaluationWorkspace.evaluationId,
      });
      return evaluationOutput(await call("GET", `${handlePath(handle)}/output?${query}`),
        handle.evaluationWorkspace.evaluationId);
    },
    async collectAgentResources(input) {
      requireSp(input.handle.framework);
      const query = input.submissionId === undefined ? "" : `?${new URLSearchParams({ submissionId: input.submissionId })}`;
      return resourceSnapshot(await call("GET", `${operationPath("resources", input.handle, input.idempotencyKey)}${query}`));
    },
    async materializeSubjectTrajectory(input) {
      const { userId, chatId } = input.subjectWorkspace;
      const { trajectoryId, path, contentHash } = input.trajectory;
      await call("POST",
        `${EVAL_HARNESS_PATH}/workspaces/${encodeURIComponent(userId)}/${encodeURIComponent(chatId)}/trajectory`,
        trajectoryRequest({
          idempotencyKey: input.idempotencyKey,
          samplingId: input.samplingId,
          trajectory: { trajectoryId, source: "subject", path, ...(contentHash === undefined ? {} : { contentHash }) },
        }));
    },
  };
}
