import type {
  AgentResourceSnapshot,
  EvaluationAgentOutput,
  ExecutionOutput,
  MaterializedDataBinding,
} from "@eval-platform/eval-contracts";
import {
  AgentIdentityConflictError,
  type AgentFailureKind,
  type AgentHandle,
  type AgentSubmission,
  type EnsureAgentInput,
  type Harness,
  type HarnessRuntimeOptions,
  type EvaluationWorkspaceBinding,
} from "@eval-platform/eval-runtime/harness";
import WebSocket from "ws";

const BASE_PATH = "/internal/v1/eval-harness";
const SERVICE_HEADER = "X-Eval-Service-Token";
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);
const STATUSES = new Set(["queued", "running", ...TERMINAL]);

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SpHarnessOptions {
  readonly origin: string;
  readonly serviceToken: string;
  readonly fetch?: Fetch;
  readonly openWebSocket?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

export class SpHarnessError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly failureKind: AgentFailureKind = "network",
    readonly status?: number,
  ) {
    super(message);
    this.name = "SpHarnessError";
  }
}

export function createSpHarness(options: SpHarnessOptions): Harness {
  const origin = new URL(options.origin);
  if (!(["http:", "https:"] as string[]).includes(origin.protocol)
    || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new TypeError("Eval SP origin must be an HTTP origin without path or credentials");
  }
  if (!options.serviceToken) throw new TypeError("Eval SP service token is required");
  const fetcher = options.fetch ?? globalThis.fetch;
  const openWebSocket = options.openWebSocket
    ?? ((url: string, headers: Readonly<Record<string, string>>) => new WebSocket(url, { headers }));

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(new URL(path, origin), {
        method,
        headers: {
          [SERVICE_HEADER]: options.serviceToken,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
      });
    } catch (cause) {
      throw new SpHarnessError(`Eval SP request failed: ${errorText(cause)}`, true);
    }
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const message = isRecord(payload)
        ? (typeof payload.errMsg === "string" ? payload.errMsg
          : typeof payload.message === "string" ? payload.message
            : `Eval SP returned ${response.status}`)
        : `Eval SP returned ${response.status}`;
      throw new SpHarnessError(
        message,
        response.status === 408 || response.status === 429 || response.status >= 500,
        "network",
        response.status,
      );
    }
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch {
      throw new SpHarnessError("Eval SP returned invalid JSON", false);
    }
  }

  const chatPath = (chatId: string): string => `${BASE_PATH}/chats/${encodeURIComponent(requiredId(chatId, "Chat ID"))}`;
  const operationPath = (chatId: string, key: string): string =>
    `${chatPath(chatId)}/submissions/by-key/${encodeURIComponent(requiredId(key, "operation key"))}`;

  async function inspect(handle: AgentHandle, idempotencyKey: string): Promise<AgentSubmission | null> {
    const value = await request("GET", operationPath(handle.chatId, idempotencyKey));
    return value === null ? null : submission(value);
  }

  async function submit(input: {
    readonly handle: AgentHandle;
    readonly idempotencyKey: string;
    readonly prompt: string;
    readonly runtime?: HarnessRuntimeOptions;
  }): Promise<AgentSubmission> {
    requireSp(input.handle);
    return submission(await request("POST", `${chatPath(input.handle.chatId)}/submissions`, {
      idempotencyKey: input.idempotencyKey,
      prompt: input.prompt,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      unattended: true,
    }));
  }

  async function observeTerminal(
    handle: AgentHandle,
    submissionId: string,
    timeoutMs?: number,
  ): Promise<AgentSubmission> {
    const url = new URL(`${chatPath(handle.chatId)}/submissions/${encodeURIComponent(submissionId)}/events`, origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = openWebSocket(url.href, { [SERVICE_HEADER]: options.serviceToken });
      } catch (cause) {
        reject(new SpHarnessError(`Eval SP WebSocket could not open: ${errorText(cause)}`, true));
        return;
      }
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: AgentSubmission | SpHarnessError): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        try { socket.close(); } catch { /* The result is already settled. */ }
        if (result instanceof SpHarnessError) reject(result);
        else resolve(result);
      };
      if (timeoutMs !== undefined) {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          finish(new SpHarnessError("Submission timeout must be positive", false));
          return;
        }
        timeout = setTimeout(() => finish(new SpHarnessError("Submission WebSocket timed out", true, "submission-timeout")), timeoutMs);
      }
      socket.addEventListener("message", (event) => {
        try {
          if (typeof event.data !== "string") throw new Error("Submission event must be JSON text");
          const envelope: unknown = JSON.parse(event.data);
          if (!isRecord(envelope) || envelope.type !== "submission.status") return;
          const current = submission(envelope.submission);
          if (current.submissionId !== submissionId) return;
          if (isTerminal(current)) finish(current);
        } catch (cause) {
          finish(new SpHarnessError(`Invalid Submission event: ${errorText(cause)}`, false));
        }
      });
      socket.addEventListener("error", () => finish(new SpHarnessError("Submission WebSocket failed", true)));
      socket.addEventListener("close", () => finish(new SpHarnessError("Submission WebSocket closed before terminal status", true)));
    });
  }

  return {
    async ensureAgent(input) {
      if (input.framework !== "sp") {
        throw new SpHarnessError(`SP Harness does not support ${input.framework} yet`, false);
      }
      if ((input.role === "evaluator") !== (input.evaluationWorkspace !== undefined)) {
        throw new SpHarnessError("Evaluator Workspace binding does not match Agent role", false);
      }
      let value: unknown;
      try {
        value = await request("PUT", chatPath(input.chatId), input);
      } catch (error) {
        if (error instanceof SpHarnessError && error.status === 409) {
          throw new AgentIdentityConflictError(input.chatId);
        }
        throw error;
      }
      return agentHandle(value, input);
    },
    async materializeInitialData(input) {
      requireSp(input.handle);
      return dataBinding(await request("POST", `${chatPath(input.handle.chatId)}/initialization`, {
        idempotencyKey: input.idempotencyKey,
        data: input.data,
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      }));
    },
    submitAgent: submit,
    restartAgent: submit,
    inspectAgentOperation(input) {
      requireSp(input.handle);
      return inspect(input.handle, input.idempotencyKey);
    },
    async waitForSubmission(input) {
      requireSp(input.handle);
      const current = await inspect(input.handle, input.idempotencyKey);
      if (!current) throw new SpHarnessError("Submission operation was not found", true);
      if (isTerminal(current)) return current;
      try {
        return await observeTerminal(input.handle, current.submissionId, input.runtime?.timeoutMs);
      } catch (error) {
        if (error instanceof SpHarnessError && !error.retryable) throw error;
        // One read reconciles a dropped terminal event. The Runtime owns retry policy.
        const reconciled = await inspect(input.handle, input.idempotencyKey);
        if (reconciled && isTerminal(reconciled)) return reconciled;
        throw error;
      }
    },
    async collectExecution({ handle }) {
      requireSp(handle);
      if (handle.role !== "subject") throw new SpHarnessError("Expected Subject Chat", false);
      const query = new URLSearchParams({ role: handle.role, samplingId: handle.samplingId });
      return executionOutput(await request("GET", `${chatPath(handle.chatId)}/output?${query}`), handle.samplingId);
    },
    async collectEvaluation({ handle }) {
      requireSp(handle);
      if (handle.role !== "evaluator" || !handle.evaluationWorkspace) {
        throw new SpHarnessError("Expected Evaluator Chat", false);
      }
      const query = new URLSearchParams({
        role: handle.role,
        samplingId: handle.samplingId,
        evaluationId: handle.evaluationWorkspace.evaluationId,
      });
      return evaluationOutput(await request("GET", `${chatPath(handle.chatId)}/output?${query}`));
    },
    async collectAgentResources(input) {
      requireSp(input.handle);
      const query = new URLSearchParams();
      if (input.submissionId !== undefined) query.set("submissionId", input.submissionId);
      const suffix = query.size > 0 ? `?${query}` : "";
      return resourceSnapshot(await request("GET", `${chatPath(input.handle.chatId)}/resources/by-key/${encodeURIComponent(requiredId(input.idempotencyKey, "operation key"))}${suffix}`));
    },
    async materializeSubjectTrajectory(input) {
      const { userId, chatId } = input.subjectWorkspace;
      await request("POST", `${BASE_PATH}/workspaces/${encodeURIComponent(requiredId(userId, "user ID"))}/${encodeURIComponent(requiredId(chatId, "Chat ID"))}/trajectory`, {
        idempotencyKey: input.idempotencyKey,
        samplingId: input.samplingId,
        trajectory: input.trajectory,
      });
    },
  };
}

function requiredId(value: string, name: string): string {
  if (typeof value !== "string" || !value) throw new SpHarnessError(`${name} is required`, false);
  return value;
}

function requireSp(handle: AgentHandle): void {
  if (handle.framework !== "sp") throw new SpHarnessError(`SP Harness does not support ${handle.framework} yet`, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SpHarnessError(`Eval SP returned invalid ${name}`, false);
  return value;
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new SpHarnessError(`Eval SP returned invalid ${name}`, false);
  return value;
}

function sameWorkspace(a: EvaluationWorkspaceBinding | undefined, b: EvaluationWorkspaceBinding | undefined): boolean {
  if (!a || !b) return a === b;
  return a.evaluationId === b.evaluationId
    && a.subject.userId === b.subject.userId
    && a.subject.chatId === b.subject.chatId;
}

function evaluationWorkspace(value: unknown): EvaluationWorkspaceBinding | undefined {
  if (value === undefined) return undefined;
  const workspace = record(value, "Evaluator Workspace binding");
  const subject = record(workspace.subject, "Subject Workspace reference");
  nonempty(workspace.evaluationId, "Evaluation ID");
  nonempty(subject.userId, "Subject user ID");
  nonempty(subject.chatId, "Subject Chat ID");
  return workspace as unknown as EvaluationWorkspaceBinding;
}

function agentHandle(value: unknown, input: EnsureAgentInput): AgentHandle {
  const result = record(value, "Agent handle");
  const workspace = evaluationWorkspace(result.evaluationWorkspace);
  if (result.chatId !== input.chatId || result.role !== input.role
    || result.framework !== input.framework || result.samplingId !== input.samplingId
    || !sameWorkspace(workspace, input.evaluationWorkspace)) {
    throw new SpHarnessError("Eval SP returned an Agent handle with different creation facts", false);
  }
  return result as unknown as AgentHandle;
}

function submission(value: unknown): AgentSubmission {
  const result = record(value, "Submission");
  nonempty(result.submissionId, "Submission ID");
  nonempty(result.status, "Submission status");
  if (result.normalizedStatus !== undefined && !STATUSES.has(String(result.normalizedStatus))) {
    throw new SpHarnessError("Eval SP returned invalid normalized Submission status", false);
  }
  if (!STATUSES.has(String(result.normalizedStatus ?? result.status))) {
    throw new SpHarnessError("Eval SP returned unknown Submission status", false);
  }
  if (result.retryable !== undefined && typeof result.retryable !== "boolean") {
    throw new SpHarnessError("Eval SP returned invalid Submission retryability", false);
  }
  return result as unknown as AgentSubmission;
}

function isTerminal(value: AgentSubmission): boolean {
  return TERMINAL.has(value.normalizedStatus ?? value.status);
}

function dataBinding(value: unknown): MaterializedDataBinding {
  const result = record(value, "initialization binding");
  nonempty(result.bundleId, "Bundle ID");
  nonempty(result.manifestHash, "manifest hash");
  nonempty(result.rootPath, "initialization root path");
  if (result.target !== "workspace" && result.target !== "sandbox") {
    throw new SpHarnessError("Eval SP returned invalid initialization target", false);
  }
  return result as unknown as MaterializedDataBinding;
}

function artifactList(value: unknown): void {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item)
    || typeof item.artifactId !== "string" || !item.artifactId
    || typeof item.kind !== "string" || !item.kind
    || typeof item.path !== "string" || !item.path)) {
    throw new SpHarnessError("Eval SP returned invalid artifact list", false);
  }
}

function trajectory(value: unknown, source: "subject" | "evaluator"): void {
  const result = record(value, "trajectory");
  nonempty(result.trajectoryId, "trajectory ID");
  nonempty(result.path, "trajectory path");
  if (result.source !== source) throw new SpHarnessError("Eval SP returned trajectory for another role", false);
}

function executionOutput(value: unknown, samplingId: string): ExecutionOutput {
  const result = record(value, "execution output");
  if (result.samplingId !== samplingId || (result.status !== "succeeded" && result.status !== "failed")) {
    throw new SpHarnessError("Eval SP returned execution output for another Sampling or status", false);
  }
  artifactList(result.artifacts);
  trajectory(result.trajectory, "subject");
  return result as unknown as ExecutionOutput;
}

function evaluationOutput(value: unknown): EvaluationAgentOutput {
  const result = record(value, "evaluation output");
  if (result.status !== "succeeded" && result.status !== "failed") {
    throw new SpHarnessError("Eval SP returned invalid evaluation output status", false);
  }
  artifactList(result.artifacts);
  trajectory(result.trajectory, "evaluator");
  return result as unknown as EvaluationAgentOutput;
}

function resourceSnapshot(value: unknown): AgentResourceSnapshot {
  const result = record(value, "resource snapshot");
  const scope = record(result.scope, "resource scope");
  nonempty(scope.chatId, "resource Chat ID");
  nonempty(scope.idempotencyKey, "resource operation key");
  nonempty(scope.submissionId, "resource Submission ID");
  nonempty(result.observedAt, "resource observation time");
  if (typeof result.finalized !== "boolean" || !isRecord(result.coverage)
    || !Array.isArray(result.usageEvents) || !Array.isArray(result.telemetryEvents)
    || !Array.isArray(result.billingSettlements)) {
    throw new SpHarnessError("Eval SP returned invalid resource snapshot", false);
  }
  return result as unknown as AgentResourceSnapshot;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
