import { isTerminalAgentStatus } from "@eval-platform/eval-contracts";
import { safeLog, type RuntimeLog } from "@eval-platform/eval-runtime";
import type { AgentSubmission } from "@eval-platform/eval-runtime/harness";
import WebSocket from "ws";
import { SpHarnessError } from "./harness-error.js";
import { submission } from "./harness-wire.js";

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_CONNECTION_ATTEMPTS = 3;
const BASE_RECONNECT_DELAY_MS = 100;

export type OpenWebSocket = (url: string, headers: Readonly<Record<string, string>>) => WebSocket;

export interface SubmissionObservation {
  /** Opens a fresh status socket for the observed Submission. */
  readonly open: () => WebSocket;
  /** Reads the observed Submission once by its ID. */
  readonly inspect: () => Promise<AgentSubmission>;
  /** A non-terminal receipt that identifies the observed Submission. */
  readonly current: AgentSubmission;
  readonly timeoutMs?: number | undefined;
  readonly log?: RuntimeLog | undefined;
  /** Identifiers only, attached to every diagnostic event. */
  readonly context?: Readonly<Record<string, string>> | undefined;
}

/**
 * Wait for the terminal status on the Submission's WebSocket. A dropped socket cannot establish the
 * terminal fact, so each disconnection reads the status once, then reconnects the same Submission
 * within a finite budget; a healthy socket is never polled. A read that fails transiently leaves the
 * status unknown: it never ends observation on its own.
 */
export async function observeTerminalSubmission(observation: SubmissionObservation): Promise<AgentSubmission> {
  const { current, timeoutMs } = observation;
  const log = safeLog(observation.log);
  const context = { ...observation.context, submissionId: current.submissionId };
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    let socketError: SpHarnessError;
    try {
      const terminal = await observeSocket(observation.open, current.submissionId,
        deadline === undefined ? undefined : Math.max(1, deadline - Date.now()),
        (event) => log({ ...event, ...context, attempt }));
      log({ name: "submission_terminal", ...context, attempt, status: terminal.status, source: "socket" });
      return terminal;
    } catch (error) {
      if (!(error instanceof SpHarnessError) || !error.retryable) throw error;
      socketError = error;
    }
    let outcome: string;
    let inspectionError: SpHarnessError | undefined;
    try {
      const reconciled = await observation.inspect();
      outcome = reconciled.status;
      log({ name: "ws_inspect", ...context, attempt, outcome });
      if (reconciled.submissionId !== current.submissionId) {
        throw new SpHarnessError("Submission operation changed during observation", false);
      }
      if (isTerminalAgentStatus(reconciled.status)) {
        log({ name: "submission_terminal", ...context, attempt, status: reconciled.status, source: "inspect" });
        return reconciled;
      }
    } catch (cause) {
      if (!(cause instanceof SpHarnessError) || !cause.retryable) throw cause;
      inspectionError = cause;
      outcome = cause.status === undefined ? `error (${cause.message})` : `HTTP ${cause.status}`;
      log({ name: "ws_inspect", ...context, attempt, outcome, error: cause.message });
    }
    if (attempt === MAX_CONNECTION_ATTEMPTS || (deadline !== undefined && Date.now() >= deadline)) {
      throw new SpHarnessError(`Submission ${current.submissionId} status unconfirmed after ${attempt} connection${
        attempt === 1 ? "" : "s"}: ${socketError.message}; last status read: ${outcome}`, true,
      { failureKind: socketError.failureKind, cause: inspectionError ?? socketError });
    }
    const delayMs = Math.floor(Math.random() * BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1));
    log({ name: "ws_reconnect", ...context, attempt, delayMs });
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}

type SocketEvent =
  | { readonly name: "ws_open" }
  | { readonly name: "ws_close"; readonly code?: number; readonly reason?: string; readonly error: string };

/** One socket lifetime: connect timeout, Ping/Pong liveness and an optional Submission deadline. */
function observeSocket(open: () => WebSocket, submissionId: string, timeoutMs: number | undefined,
  report: (event: SocketEvent) => void): Promise<AgentSubmission> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = open();
    } catch (cause) {
      reject(new SpHarnessError("Eval SP WebSocket could not open", true, { cause }));
      return;
    }
    let settled = false;
    let connected = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setTimeout> | undefined;
    let pongTimeout: ReturnType<typeof setTimeout> | undefined;
    const connectTimeout = setTimeout(
      () => finish(new SpHarnessError("Submission WebSocket could not connect", true)), PONG_TIMEOUT_MS);
    const finish = (result: AgentSubmission | SpHarnessError, close?: { readonly code?: number; readonly reason?: string }): void => {
      if (settled) return;
      settled = true;
      if (result instanceof SpHarnessError) report({ name: "ws_close", ...close, error: result.message });
      clearTimeout(connectTimeout);
      clearTimeout(deadline);
      clearTimeout(pingTimer);
      clearTimeout(pongTimeout);
      try {
        if (result instanceof SpHarnessError) socket.terminate();
        else socket.close();
      } catch { /* The observation is already settled. */ }
      if (result instanceof SpHarnessError) reject(result);
      else resolve(result);
    };
    const schedulePing = (): void => {
      pingTimer = setTimeout(() => {
        pongTimeout = setTimeout(
          () => finish(new SpHarnessError("Submission WebSocket stopped responding", true)), PONG_TIMEOUT_MS);
        try {
          socket.ping();
        } catch (cause) {
          finish(new SpHarnessError("Submission WebSocket ping failed", true, { cause }));
        }
      }, PING_INTERVAL_MS);
    };
    const onOpen = (): void => {
      if (settled || connected) return;
      connected = true;
      clearTimeout(connectTimeout);
      report({ name: "ws_open" });
      schedulePing();
    };
    socket.addEventListener("open", onOpen);
    socket.on("pong", () => {
      if (!pongTimeout || settled) return;
      clearTimeout(pongTimeout);
      pongTimeout = undefined;
      schedulePing();
    });
    if (socket.readyState === WebSocket.OPEN) onOpen();
    if (timeoutMs !== undefined) {
      deadline = setTimeout(() => finish(new SpHarnessError("Submission WebSocket timed out", true,
        { failureKind: "submission-timeout" })), timeoutMs);
    }
    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string") throw new TypeError("Submission event must be JSON text");
        const envelope: unknown = JSON.parse(event.data);
        if (!isStatusEvent(envelope)) return;
        const observed = submission(envelope.submission);
        if (observed.submissionId === submissionId && isTerminalAgentStatus(observed.status)) finish(observed);
      } catch (cause) {
        finish(new SpHarnessError("Invalid Submission event", false, { cause }));
      }
    });
    socket.addEventListener("error", () => finish(new SpHarnessError("Submission WebSocket failed", true)));
    socket.addEventListener("close", (event: { readonly code?: unknown; readonly reason?: unknown }) => {
      const code = typeof event.code === "number" ? event.code : undefined;
      const reason = typeof event.reason === "string" && event.reason !== "" ? event.reason : undefined;
      finish(new SpHarnessError(`Submission WebSocket closed before terminal status${code === undefined ? "" : ` (code ${code})`}`, true),
        { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
    });
  });
}

function isStatusEvent(value: unknown): value is { readonly type: "submission.status"; readonly submission: unknown } {
  return value !== null && typeof value === "object" && (value as { type?: unknown }).type === "submission.status";
}
