import { isTerminalAgentStatus } from "@eval-platform/eval-contracts";
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
  /** Reads the Submission once through its operation key. */
  readonly inspect: () => Promise<AgentSubmission | null>;
  /** A non-terminal receipt that identifies the observed Submission. */
  readonly current: AgentSubmission;
  readonly timeoutMs?: number | undefined;
}

/**
 * Wait for the terminal status on the Submission's WebSocket. A dropped socket cannot establish the
 * terminal fact, so each disconnection reads the status once, then reconnects within a finite budget;
 * a healthy socket is never polled.
 */
export async function observeTerminalSubmission(observation: SubmissionObservation): Promise<AgentSubmission> {
  const { current, timeoutMs } = observation;
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await observeSocket(observation.open, current.submissionId,
        deadline === undefined ? undefined : Math.max(1, deadline - Date.now()));
    } catch (error) {
      if (!(error instanceof SpHarnessError) || !error.retryable) throw error;
      let reconciled: AgentSubmission | null = null;
      let inspectionError: SpHarnessError | undefined;
      try {
        reconciled = await observation.inspect();
      } catch (cause) {
        if (!(cause instanceof SpHarnessError) || !cause.retryable) throw cause;
        inspectionError = cause;
      }
      if (reconciled && reconciled.submissionId !== current.submissionId) {
        throw new SpHarnessError("Submission operation changed during observation", false);
      }
      if (reconciled && isTerminalAgentStatus(reconciled.status)) return reconciled;
      if ((!reconciled && !inspectionError) || attempt === MAX_CONNECTION_ATTEMPTS
        || (deadline !== undefined && Date.now() >= deadline)) {
        throw inspectionError ?? error;
      }
      const delay = Math.floor(Math.random() * BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1));
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** One socket lifetime: connect timeout, Ping/Pong liveness and an optional Submission deadline. */
function observeSocket(open: () => WebSocket, submissionId: string, timeoutMs?: number): Promise<AgentSubmission> {
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
    const finish = (result: AgentSubmission | SpHarnessError): void => {
      if (settled) return;
      settled = true;
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
    socket.addEventListener("close",
      () => finish(new SpHarnessError("Submission WebSocket closed before terminal status", true)));
  });
}

function isStatusEvent(value: unknown): value is { readonly type: "submission.status"; readonly submission: unknown } {
  return value !== null && typeof value === "object" && (value as { type?: unknown }).type === "submission.status";
}
