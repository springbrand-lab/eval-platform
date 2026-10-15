import { describe, expect, it, vi } from "vitest";
import { AgentHandleNotFoundError, AgentIdentityConflictError, type AgentHandle } from "@eval-platform/eval-runtime";
import WebSocket, { WebSocketServer } from "ws";
import { createSpHarness, SpHarnessError } from "./harness.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const SUBJECT_CHAT = "33333333-3333-4333-8333-333333333333";
const EVALUATOR_CHAT = "44444444-4444-4444-8444-444444444444";
const MISSING_CHAT = "55555555-5555-4555-8555-555555555555";
const AGENT_CONFIG = "66666666-6666-4666-8666-666666666666";
const CHAT_PATH = `/internal/v1/eval-harness/users/${OWNER}/chats/${SUBJECT_CHAT}`;

const subject: AgentHandle = {
  ownerUserId: OWNER,
  chatId: SUBJECT_CHAT,
  samplingId: "sampling-1",
  role: "subject",
  framework: "sp",
};
const evaluator: AgentHandle = {
  ownerUserId: OWNER,
  chatId: EVALUATOR_CHAT,
  samplingId: "sampling-1",
  role: "evaluator",
  framework: "sp",
  evaluationWorkspace: {
    subject: { userId: OWNER, chatId: SUBJECT_CHAT },
    evaluationId: "evaluation-1",
  },
};
const executionOutput = {
  samplingId: "sampling-1",
  status: "succeeded",
  artifacts: [{ artifactId: "artifact-1", kind: "project", path: "/project" }],
  trajectory: { trajectoryId: "trajectory-1", source: "subject", path: "/trajectory.jsonl" },
};
const resources = {
  scope: { chatId: SUBJECT_CHAT, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" },
  observedAt: "2026-10-14T00:00:00.000Z",
  finalized: true,
  coverage: { usageEvents: "complete", telemetryEvents: "partial", billingSettlements: "complete" },
  usageEvents: [{ eventId: "usage-1", unknownField: null }],
  telemetryEvents: [{ eventId: "event-1" }],
  billingSettlements: [{ eventId: "billing-1", chargedCredits: 7 }],
};
const binding = (bundleId: string, rootPath = "/") => ({ bundleId, manifestHash: "hash", target: "workspace", rootPath });

function receipt(normalizedStatus: string, submissionId = "submission-1") {
  const status = { queued: "pending", running: "running", completed: "completed", failed: "error" }[normalizedStatus];
  return { submissionId, status, normalizedStatus, accepted: true, createdAt: 1 };
}

function ensureInput(handle: AgentHandle) {
  const { ownerUserId, ...creation } = handle;
  return {
    ...creation,
    projectId: "project-1",
    agentConfig: { ownerUserId, userAgentId: AGENT_CONFIG },
  };
}

/** A fetch double that records each request the Harness sends. */
function spFetch(respond: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return respond(request);
  });
  return { fetch, requests };
}

function queuedFetch(...responses: Response[]) {
  return spFetch(() => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  });
}

class FakeSocket extends EventTarget {
  closed = false;
  readyState = WebSocket.OPEN;
  ping = vi.fn();

  on(event: string, listener: () => void): this {
    this.addEventListener(event, listener);
    return this;
  }

  terminate(): void { this.close(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }

  sendStatus(submission: unknown): void {
    this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "submission.status", submission }),
    }));
  }

  sendPong(): void { this.dispatchEvent(new Event("pong")); }
}

describe("Eval SP Harness", () => {
  it("stops an Eval Chat through the service route and accepts an already absent Chat", async () => {
    const { fetch, requests } = spFetch((request) => request.url.includes(MISSING_CHAT)
      ? Response.json({ code: "REQUEST_NOT_FOUND", errMsg: "Resource not found" }, { status: 404 })
      : Response.json({ ok: true }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    expect(await harness.stopAgent({ handle: subject })).toBe(true);
    expect([requests[0]!.method, requests[0]!.url, requests[0]!.headers.get("X-Eval-Service-Token")]).toEqual([
      "POST", `https://eval-sp.test${CHAT_PATH}/submissions/stop`, "secret",
    ]);
    expect(await harness.stopAgent({ handle: { ...subject, chatId: MISSING_CHAT } })).toBe(false);
    await expect(harness.inspectAgentOperation({
      handle: { ...subject, chatId: MISSING_CHAT }, idempotencyKey: "execution:sampling-1",
    })).rejects.toBeInstanceOf(AgentHandleNotFoundError);
  });

  it("bounds a stuck SP stop request with the stop timeout", async () => {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const { signal } = new Request(input, init);
      signal.addEventListener("abort", () => reject(signal.reason));
    }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, stopTimeoutMs: 10 });
    await expect(harness.stopAgent({ handle: subject })).rejects.toMatchObject({
      name: "SpHarnessError", retryable: true, message: "Eval SP request failed: REQUEST_TIMEOUT",
    });
  });

  it("classifies SP failures by whether repeating the idempotent operation can succeed", async () => {
    const { fetch } = queuedFetch(
      Response.json({ code: "INTERNAL_ERROR", errMsg: "Durable Object reset" }, { status: 503 }),
      Response.json({ code: "REQUEST_VALIDATION_FAILED", errMsg: "Invalid key" }, { status: 422 }),
      new Response("not json", { status: 200 }),
    );
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    const operation = { handle: subject, idempotencyKey: "execution:sampling-1" };
    await expect(harness.inspectAgentOperation(operation)).rejects.toMatchObject({
      retryable: true, status: 503, message: "Durable Object reset",
    });
    await expect(harness.inspectAgentOperation(operation)).rejects.toMatchObject({ retryable: false, status: 422 });
    await expect(harness.inspectAgentOperation(operation)).rejects.toMatchObject({
      retryable: false, message: "Eval SP request failed: RESPONSE_INVALID",
    });
  });

  it("uses service-authenticated public operations and preserves evidence and raw resource facts", async () => {
    const { fetch, requests } = spFetch((request) => {
      const url = new URL(request.url);
      if (request.method === "PUT" && url.pathname === CHAT_PATH) return Response.json(subject);
      if (request.method === "POST" && url.pathname.endsWith("/initialization")) {
        return Response.json(binding("bundle-1", "/input"));
      }
      if (request.method === "POST" && url.pathname.endsWith("/submissions")) return Response.json(receipt("completed"));
      if (request.method === "GET" && url.pathname.includes("/submissions/by-key/")) {
        return Response.json(receipt("completed"));
      }
      if (request.method === "GET" && url.pathname.endsWith("/output")) return Response.json(executionOutput);
      if (request.method === "GET" && url.pathname.includes("/resources/by-key/")) return Response.json(resources);
      if (request.method === "POST" && url.pathname.endsWith("/trajectory")) return new Response(null, { status: 204 });
      throw new Error(`Unexpected ${request.method} ${url}`);
    });
    const resolveInitialMaterials = vi.fn(async () => [
      { path: "/brief.txt", mediaType: "text/plain", contentBase64: "SGVsbG8=" },
    ]);
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "service-secret", fetch, resolveInitialMaterials });
    expect(await harness.ensureAgent(ensureInput(subject))).toEqual(subject);
    expect(await harness.materializeInitialData({
      handle: subject,
      idempotencyKey: "initial-data:subject-chat",
      data: { userPrompt: "Build a project", initialMaterials: { bundleId: "bundle-1", materialId: "material-1" } },
    })).toMatchObject({ bundleId: "bundle-1", target: "workspace" });
    expect(await harness.submitAgent({ handle: subject, idempotencyKey: "execution:sampling-1", prompt: "Build a project" }))
      .toEqual({ submissionId: "submission-1", status: "completed", accepted: true, createdAt: 1 });
    expect((await harness.inspectAgentOperation({ handle: subject, idempotencyKey: "execution:sampling-1" }))?.submissionId)
      .toBe("submission-1");
    expect(await harness.collectExecution({ handle: subject })).toEqual(executionOutput);
    expect(await harness.collectAgentResources({ handle: subject, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" }))
      .toEqual(resources);
    await harness.materializeSubjectTrajectory({
      subjectWorkspace: { userId: OWNER, chatId: SUBJECT_CHAT },
      samplingId: subject.samplingId,
      trajectory: executionOutput.trajectory as typeof executionOutput.trajectory & { source: "subject" },
      idempotencyKey: "subject-trajectory:subject-chat",
    });

    expect(requests).toHaveLength(7);
    expect(requests.slice(0, 6).every((request) => new URL(request.url).pathname.startsWith(CHAT_PATH))).toBe(true);
    expect(new URL(requests[6]!.url).pathname)
      .toBe(`/internal/v1/eval-harness/workspaces/${OWNER}/${SUBJECT_CHAT}/trajectory`);
    expect(requests.every((request) => request.headers.get("X-Eval-Service-Token") === "service-secret")).toBe(true);
    expect(await requests[0]!.json()).toEqual(ensureInput(subject));
    expect(await requests[1]!.json()).toEqual({
      idempotencyKey: "initial-data:subject-chat",
      data: { userPrompt: "Build a project", initialMaterials: { bundleId: "bundle-1", materialId: "material-1" } },
      initialMaterials: { bundleId: "bundle-1", materialId: "material-1",
        files: [{ path: "/brief.txt", mediaType: "text/plain", contentBase64: "SGVsbG8=" }] },
    });
    expect(resolveInitialMaterials).toHaveBeenCalledWith(OWNER, { bundleId: "bundle-1", materialId: "material-1" });
    expect(await requests[2]!.json()).toEqual({ idempotencyKey: "execution:sampling-1", prompt: "Build a project", unattended: true });
    expect(new URL(requests[5]!.url).searchParams.get("submissionId")).toBe("submission-1");
    expect(await requests[6]!.json()).toEqual({
      idempotencyKey: "subject-trajectory:subject-chat", samplingId: "sampling-1", trajectory: executionOutput.trajectory,
    });
  });

  it("ensures an evaluator Chat with its immutable Subject Workspace binding", async () => {
    const { fetch, requests } = spFetch((request) => new URL(request.url).pathname.endsWith("/output")
      ? Response.json({
        status: "succeeded",
        artifacts: [{ artifactId: "judge-output", kind: "evaluation", path: "/evaluations/evaluation-1/result.json" }],
        trajectory: { trajectoryId: "judge-trace", source: "evaluator", path: "/evaluations/evaluation-1/trajectory.jsonl" },
      })
      : Response.json(evaluator));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    expect(await harness.ensureAgent(ensureInput(evaluator))).toEqual(evaluator);
    expect((await harness.collectEvaluation({ handle: evaluator })).trajectory.source).toBe("evaluator");
    expect(new URL(requests[1]!.url).searchParams.get("evaluationId")).toBe("evaluation-1");
  });

  it("rejects a request that violates the SP contract before contacting SP", async () => {
    const fetch = vi.fn();
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    const { evaluationWorkspace: _binding, ...unbound } = ensureInput(evaluator);
    await expect(harness.ensureAgent(unbound))
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
    await expect(harness.ensureAgent({ ...ensureInput(subject), chatId: "not-a-uuid" }))
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
    await expect(harness.submitAgent({ handle: subject, idempotencyKey: "execution:sampling-1", prompt: "  " }))
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uploads the Project JSON Schema with evaluator-only materials before submission", async () => {
    const { fetch, requests } = spFetch(() => Response.json(binding("eval-bundle",
      "/evaluations/evaluation-1/initial-materials/eval-bundle/judge-brief")));
    const resolveInitialMaterials = vi.fn(async () => [
      { path: "/brief.txt", mediaType: "text/plain", contentBase64: "SnVkZ2U=" },
    ]);
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, resolveInitialMaterials });
    const evalMaterials = { bundleId: "eval-bundle", materialId: "judge-brief" };
    const materialized = await harness.materializeInitialData({
      handle: evaluator, idempotencyKey: "initial-data:evaluator-chat",
      data: { userPrompt: "Judge", initialMaterials: evalMaterials },
      evaluationOutputSchema: { type: "object", properties: { score: { type: "number" } } },
    });
    expect(resolveInitialMaterials).toHaveBeenCalledWith(OWNER, evalMaterials);
    const body = await requests[0]!.json();
    expect(body.initialMaterials).toMatchObject(evalMaterials);
    expect(body.initialMaterials.files.map((file: { path: string }) => file.path))
      .toEqual(["/brief.txt", "/evaluation-output.schema.json"]);
    expect(`${materialized.rootPath}${body.initialMaterials.files[1].path}`).toBe(
      "/evaluations/evaluation-1/initial-materials/eval-bundle/judge-brief/evaluation-output.schema.json",
    );
    expect(JSON.parse(Buffer.from(body.initialMaterials.files[1].contentBase64, "base64").toString("utf8")))
      .toEqual({ type: "object", properties: { score: { type: "number" } } });
    expect(body.data).not.toHaveProperty("evalInitialMaterials");
  });

  it("materializes a schema even without evaluator materials and reserves its path", async () => {
    const { fetch, requests } = spFetch(() => Response.json(binding("schema", "/evaluations/evaluation-1")));
    const schema = { type: "object" };
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await harness.materializeInitialData({ handle: evaluator, idempotencyKey: "init", data: { userPrompt: "Judge" },
      evaluationOutputSchema: schema });
    const body = await requests[0]!.json();
    expect(body.initialMaterials.files).toHaveLength(1);
    expect(body.initialMaterials.files[0].path).toBe("/evaluation-output.schema.json");
    expect(body.data.initialMaterials).toMatchObject({ bundleId: "project-evaluation-output-schema" });
    await expect(harness.materializeInitialData({ handle: evaluator, idempotencyKey: "missing",
      data: { userPrompt: "Judge" } })).rejects.toMatchObject({ retryable: false });
    expect(fetch).toHaveBeenCalledOnce();

    const collision = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch,
      resolveInitialMaterials: async () => [{ path: "/evaluation-output.schema.json",
        mediaType: "application/json", contentBase64: "e30=" }] });
    await expect(collision.materializeInitialData({ handle: evaluator, idempotencyKey: "collision",
      data: { userPrompt: "Judge", initialMaterials: { bundleId: "bundle", materialId: "material" } },
      evaluationOutputSchema: schema })).rejects.toMatchObject({ retryable: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not submit a material reference without its per-Sample files", async () => {
    const fetch = vi.fn();
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.materializeInitialData({
      handle: subject,
      idempotencyKey: "initial-data:subject-chat",
      data: { userPrompt: "Build a project", initialMaterials: { bundleId: "bundle-1", materialId: "material-1" } },
    })).rejects.toMatchObject({ retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("includes canonical Session content when a resolver supplies it", async () => {
    const { fetch, requests } = spFetch(() => Response.json(binding("sessions")));
    const resolveInitialSession = vi.fn(async () => ({
      format: "jsonl" as const,
      content: '{"id":"m1","message":{"role":"user","content":"Hi"},"createdAt":1}',
    }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, resolveInitialSession });
    await harness.materializeInitialData({
      handle: subject,
      idempotencyKey: "init-session",
      data: { userPrompt: "Continue", initialSession: { bundleId: "sessions", sessionId: "seed" } },
    });
    expect(resolveInitialSession).toHaveBeenCalledWith(OWNER, { bundleId: "sessions", sessionId: "seed" });
    expect(await requests[0]!.json()).toMatchObject({
      initialSession: { bundleId: "sessions", sessionId: "seed", context: { format: "jsonl", content: expect.any(String) } },
    });
  });

  it("sends the Session reference when its optional context file is absent", async () => {
    const { fetch, requests } = spFetch(() => Response.json(binding("sessions")));
    const resolveInitialSession = vi.fn(async () => undefined);
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, resolveInitialSession });
    await harness.materializeInitialData({
      handle: subject,
      idempotencyKey: "init-reference-only",
      data: { userPrompt: "Continue", initialSession: { bundleId: "sessions", sessionId: "seed" } },
    });
    expect((await requests[0]!.json()).initialSession).toEqual({ bundleId: "sessions", sessionId: "seed" });
  });

  it("maps immutable Chat conflicts and rejects other frameworks before contacting SP", async () => {
    const { fetch } = queuedFetch(Response.json({ code: "REQUEST_CONFLICT", errMsg: "Conflict" }, { status: 409 }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.ensureAgent(ensureInput(subject))).rejects.toBeInstanceOf(AgentIdentityConflictError);
    await expect(harness.ensureAgent({ ...ensureInput(subject), framework: "codex" })).rejects.toMatchObject({
      retryable: false, message: "SP Harness cannot run codex Agents",
    });
    await expect(harness.collectExecution({ handle: { ...subject, framework: "cc" } })).rejects.toMatchObject({
      retryable: false, message: "SP Harness cannot run cc Agents",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a Chat handle returned for another Inbox owner", async () => {
    const { fetch } = queuedFetch(Response.json({ ...subject, ownerUserId: OTHER_OWNER }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.ensureAgent(ensureInput(subject))).rejects.toMatchObject({ retryable: false });
  });

  it("waits for the target Submission on a WebSocket and ignores another Submission", async () => {
    const socket = new FakeSocket();
    const openWebSocket = vi.fn((_url: string, _headers: Readonly<Record<string, string>>) => socket as unknown as WebSocket);
    const { fetch } = queuedFetch(Response.json(receipt("running")));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, openWebSocket });
    const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
    socket.sendStatus(receipt("completed", "another-submission"));
    socket.sendStatus(receipt("running"));
    socket.sendStatus(receipt("completed"));
    await expect(waiting).resolves.toMatchObject({ submissionId: "submission-1", status: "completed" });
    expect(socket.closed).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(openWebSocket.mock.calls[0]![0]).toBe(`wss://eval-sp.test${CHAT_PATH}/submissions/submission-1/events`);
    expect(openWebSocket.mock.calls[0]![1]).toEqual({ "X-Eval-Service-Token": "secret" });
  });

  it("does one status read after a dropped socket instead of polling", async () => {
    const socket = new FakeSocket();
    const openWebSocket = vi.fn((_url: string, _headers: Readonly<Record<string, string>>) => socket as unknown as WebSocket);
    const { fetch } = queuedFetch(Response.json(receipt("running")), Response.json(receipt("completed")));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, openWebSocket });
    const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
    socket.close();
    await expect(waiting).resolves.toMatchObject({ status: "completed" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("detects a silent socket with protocol Ping/Pong and reconciles the terminal status", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const openWebSocket = vi.fn(() => socket as unknown as WebSocket);
      const { fetch } = queuedFetch(Response.json(receipt("running")), Response.json(receipt("failed")));
      const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, openWebSocket });
      const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
      await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(waiting).resolves.toMatchObject({ status: "failed" });
      expect(socket.ping).toHaveBeenCalledOnce();
      expect(socket.closed).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a responsive observer connected without extra status reads", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      socket.ping.mockImplementation(() => socket.sendPong());
      const openWebSocket = vi.fn(() => socket as unknown as WebSocket);
      const { fetch } = queuedFetch(Response.json(receipt("running")));
      const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, openWebSocket });
      const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
      await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(120_000);
      expect(socket.ping).toHaveBeenCalledTimes(4);
      expect(socket.closed).toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
      socket.sendStatus(receipt("completed"));
      await expect(waiting).resolves.toMatchObject({ status: "completed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a Submission deadline as a Submission timeout", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      socket.ping.mockImplementation(() => socket.sendPong());
      const openWebSocket = vi.fn(() => socket as unknown as WebSocket);
      const { fetch } = queuedFetch(Response.json(receipt("running")), Response.json(receipt("running")));
      const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, openWebSocket });
      const waiting = harness.waitForSubmission({
        handle: subject, idempotencyKey: "execution:sampling-1", runtime: { timeoutMs: 5_000 },
      });
      const outcome = expect(waiting).rejects.toMatchObject({ retryable: true, failureKind: "submission-timeout" });
      await vi.advanceTimersByTimeAsync(5_000);
      await outcome;
      expect(openWebSocket).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reopens the same Submission after a dropped observer reports it is still running", async () => {
    const first = new FakeSocket();
    const sockets = [first, new FakeSocket()];
    const openWebSocket = vi.fn((_url: string, _headers: Readonly<Record<string, string>>) => sockets.shift() as unknown as WebSocket);
    const { fetch } = queuedFetch(Response.json(receipt("running")), Response.json(receipt("running")));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, openWebSocket });
    const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
    first.close();
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledTimes(2));
    const second = openWebSocket.mock.results[1]!.value as unknown as FakeSocket;
    second.sendStatus(receipt("completed"));
    await expect(waiting).resolves.toMatchObject({ status: "completed" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(openWebSocket.mock.calls[1]![0]).toBe(openWebSocket.mock.calls[0]![0]);
  });

  it("reopens the observer when a single disconnection status read temporarily fails", async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const openWebSocket = vi.fn((_url: string, _headers: Readonly<Record<string, string>>) => sockets.shift() as unknown as WebSocket);
    const { fetch } = queuedFetch(Response.json(receipt("running")), new Response(null, { status: 503 }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, openWebSocket });
    const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
    first.close();
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledTimes(2));
    second.sendStatus(receipt("completed"));
    await expect(waiting).resolves.toMatchObject({ status: "completed" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops reopening after the finite observer retry budget", async () => {
    const openWebSocket = vi.fn(() => {
      const socket = new FakeSocket();
      queueMicrotask(() => socket.close());
      return socket as unknown as WebSocket;
    });
    const { fetch } = spFetch(() => Response.json(receipt("running")));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, openWebSocket });
    await expect(harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" }))
      .rejects.toMatchObject({ retryable: true });
    expect(openWebSocket).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("sends service authentication on a real WebSocket upgrade", async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("WebSocket server did not bind a TCP port");
    let receivedToken: string | undefined;
    server.on("connection", (socket, request) => {
      const header = request.headers["x-eval-service-token"];
      receivedToken = Array.isArray(header) ? header[0] : header;
      socket.send(JSON.stringify({ type: "submission.status", submission: receipt("completed") }));
    });
    try {
      const { fetch } = spFetch(() => Response.json(receipt("running")));
      const harness = createSpHarness({ origin: `http://127.0.0.1:${address.port}`, serviceToken: "service-secret", fetch });
      await expect(harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" }))
        .resolves.toMatchObject({ status: "completed" });
      expect(receivedToken).toBe("service-secret");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects missing evidence rather than reporting an incomplete Subject output", async () => {
    const { fetch } = queuedFetch(Response.json({ samplingId: "sampling-1", status: "succeeded", artifacts: [] }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.collectExecution({ handle: subject })).rejects.toBeInstanceOf(SpHarnessError);
  });
});
