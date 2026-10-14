import { describe, expect, it, vi } from "vitest";
import { AgentIdentityConflictError, type AgentHandle } from "@eval-platform/eval-runtime";
import WebSocket, { WebSocketServer } from "ws";
import { createSpHarness, SpHarnessError } from "./harness.js";

const subject: AgentHandle = {
  chatId: "subject-chat",
  samplingId: "sampling-1",
  role: "subject",
  framework: "sp",
};
const evaluator: AgentHandle = {
  chatId: "evaluator-chat",
  samplingId: "sampling-1",
  role: "evaluator",
  framework: "sp",
  evaluationWorkspace: {
    subject: { userId: "user-1", chatId: subject.chatId },
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
  scope: { chatId: subject.chatId, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" },
  observedAt: "2026-10-14T00:00:00.000Z",
  finalized: true,
  coverage: { usageEvents: "complete", telemetryEvents: "partial", billingSettlements: "complete" },
  usageEvents: [{ eventId: "usage-1", unknownField: null }],
  telemetryEvents: [{ eventId: "event-1" }],
  billingSettlements: [{ eventId: "billing-1", chargedCredits: 7 }],
};

function ensureInput(handle: AgentHandle) {
  return {
    ...handle,
    projectId: "project-1",
    agentConfig: { ownerUserId: "user-1", userAgentId: "agent-config-1" },
  };
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
  it("uses service-authenticated public operations and preserves evidence and raw resource facts", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "PUT" && url.pathname.endsWith("/chats/subject-chat")) return Response.json(subject);
      if (method === "POST" && url.pathname.endsWith("/initialization")) {
        return Response.json({ bundleId: "bundle-1", manifestHash: "hash-1", target: "workspace", rootPath: "/input" });
      }
      if (method === "POST" && url.pathname.endsWith("/submissions")) {
        return Response.json({ submissionId: "submission-1", status: "completed", normalizedStatus: "completed" });
      }
      if (method === "GET" && url.pathname.includes("/submissions/by-key/")) {
        return Response.json({ submissionId: "submission-1", status: "completed", normalizedStatus: "completed" });
      }
      if (method === "GET" && url.pathname.endsWith("/output")) return Response.json(executionOutput);
      if (method === "GET" && url.pathname.includes("/resources/by-key/")) return Response.json(resources);
      if (method === "POST" && url.pathname.endsWith("/trajectory")) return new Response(null, { status: 204 });
      throw new Error(`Unexpected ${method} ${url}`);
    });
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "service-secret", fetch: fetcher });
    expect(await harness.ensureAgent(ensureInput(subject))).toEqual(subject);
    expect(await harness.materializeInitialData({
      handle: subject,
      idempotencyKey: "initial-data:subject-chat",
      data: { userPrompt: "Build a project", initialMaterials: { bundleId: "bundle-1", materialId: "material-1" } },
    })).toMatchObject({ bundleId: "bundle-1", target: "workspace" });
    expect((await harness.submitAgent({ handle: subject, idempotencyKey: "execution:sampling-1", prompt: "Build a project" })).submissionId)
      .toBe("submission-1");
    expect((await harness.inspectAgentOperation({ handle: subject, idempotencyKey: "execution:sampling-1" }))?.submissionId)
      .toBe("submission-1");
    expect(await harness.collectExecution({ handle: subject })).toEqual(executionOutput);
    expect(await harness.collectAgentResources({ handle: subject, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" }))
      .toEqual(resources);
    await harness.materializeSubjectTrajectory({
      subjectWorkspace: { userId: "user-1", chatId: subject.chatId },
      samplingId: subject.samplingId,
      trajectory: executionOutput.trajectory as typeof executionOutput.trajectory & { source: "subject" },
      idempotencyKey: "subject-trajectory:subject-chat",
    });

    expect(fetcher).toHaveBeenCalledTimes(7);
    const requests = fetcher.mock.calls.map(([input, init]) => ({ url: new URL(String(input)), init }));
    expect(requests.every(({ init }) => new Headers(init?.headers).get("X-Eval-Service-Token") === "service-secret")).toBe(true);
    expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject(ensureInput(subject));
    expect(JSON.parse(String(requests[1]!.init?.body))).toMatchObject({
      idempotencyKey: "initial-data:subject-chat",
      data: { initialMaterials: { bundleId: "bundle-1", materialId: "material-1" } },
    });
    expect(JSON.parse(String(requests[2]!.init?.body))).toMatchObject({ unattended: true, idempotencyKey: "execution:sampling-1" });
    expect(requests[5]!.url.searchParams.get("submissionId")).toBe("submission-1");
  });

  it("ensures an evaluator Chat with its immutable Subject Workspace binding", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/output")) return Response.json({
        status: "succeeded",
        artifacts: [{ artifactId: "judge-output", kind: "evaluation", path: "/evaluations/evaluation-1/result.json" }],
        trajectory: { trajectoryId: "judge-trace", source: "evaluator", path: "/evaluations/evaluation-1/trajectory.jsonl" },
      });
      return Response.json(evaluator);
    });
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch: fetcher });
    expect(await harness.ensureAgent(ensureInput(evaluator))).toEqual(evaluator);
    expect((await harness.collectEvaluation({ handle: evaluator })).trajectory.source).toBe("evaluator");
    const outputUrl = new URL(String(fetcher.mock.calls[1]![0]));
    expect(outputUrl.searchParams.get("evaluationId")).toBe("evaluation-1");
  });

  it("maps immutable Chat conflicts and rejects unsupported frameworks before contacting SP", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 409 }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch: fetcher });
    await expect(harness.ensureAgent(ensureInput(subject))).rejects.toBeInstanceOf(AgentIdentityConflictError);
    await expect(harness.ensureAgent({ ...ensureInput(subject), framework: "codex" })).rejects.toMatchObject({ retryable: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("waits for the target Submission on a WebSocket and ignores another Submission", async () => {
    const socket = new FakeSocket();
    const openWebSocket = vi.fn((_url: string, _headers: Readonly<Record<string, string>>) => socket as unknown as WebSocket);
    const fetcher = vi.fn(async () => Response.json({ submissionId: "submission-1", status: "running" }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch: fetcher, openWebSocket });
    const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
    socket.sendStatus({ submissionId: "another-submission", status: "completed" });
    socket.sendStatus({ submissionId: "submission-1", status: "running" });
    socket.sendStatus({ submissionId: "submission-1", status: "completed", normalizedStatus: "completed" });
    await expect(waiting).resolves.toMatchObject({ submissionId: "submission-1", status: "completed" });
    expect(socket.closed).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(openWebSocket.mock.calls[0]![0]).toBe("wss://eval-sp.test/internal/v1/eval-harness/chats/subject-chat/submissions/submission-1/events");
    expect(openWebSocket.mock.calls[0]![1]).toEqual({ "X-Eval-Service-Token": "secret" });
  });

  it("does one status read after a dropped socket instead of polling", async () => {
    const socket = new FakeSocket();
    const openWebSocket = vi.fn((_url: string, _headers: Readonly<Record<string, string>>) => socket as unknown as WebSocket);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ submissionId: "submission-1", status: "running" }))
      .mockResolvedValueOnce(Response.json({ submissionId: "submission-1", status: "completed" }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch: fetcher, openWebSocket });
    const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
    socket.close();
    await expect(waiting).resolves.toMatchObject({ status: "completed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("detects a silent socket with protocol Ping/Pong and reconciles the terminal status", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const openWebSocket = vi.fn(() => socket as unknown as WebSocket);
      const fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({ submissionId: "submission-1", status: "running" }))
        .mockResolvedValueOnce(Response.json({ submissionId: "submission-1", status: "failed" }));
      const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch: fetcher, openWebSocket });
      const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
      await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(waiting).resolves.toMatchObject({ status: "failed" });
      expect(socket.ping).toHaveBeenCalledOnce();
      expect(socket.closed).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
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
      const fetcher = vi.fn(async () => Response.json({ submissionId: "submission-1", status: "running" }));
      const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch: fetcher, openWebSocket });
      const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
      await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(120_000);
      expect(socket.ping).toHaveBeenCalledTimes(4);
      expect(socket.closed).toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
      socket.sendStatus({ submissionId: "submission-1", status: "completed" });
      await expect(waiting).resolves.toMatchObject({ status: "completed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reopens the same Submission after a dropped observer reports it is still running", async () => {
    const first = new FakeSocket();
    const sockets = [first, new FakeSocket()];
    const openWebSocket = vi.fn((_url: string, _headers: Readonly<Record<string, string>>) => sockets.shift() as unknown as WebSocket);
    const fetcher = vi.fn(async () => Response.json({ submissionId: "submission-1", status: "running" }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch: fetcher, openWebSocket });
    const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
    first.close();
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledTimes(2));
    const second = openWebSocket.mock.results[1]!.value as unknown as FakeSocket;
    second.sendStatus({ submissionId: "submission-1", status: "completed" });
    await expect(waiting).resolves.toMatchObject({ status: "completed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(openWebSocket.mock.calls[1]![0]).toBe(openWebSocket.mock.calls[0]![0]);
  });

  it("reopens the observer when a single disconnection status read temporarily fails", async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const openWebSocket = vi.fn((_url: string, _headers: Readonly<Record<string, string>>) => sockets.shift() as unknown as WebSocket);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ submissionId: "submission-1", status: "running" }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch: fetcher, openWebSocket });
    const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
    first.close();
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledTimes(2));
    second.sendStatus({ submissionId: "submission-1", status: "completed" });
    await expect(waiting).resolves.toMatchObject({ status: "completed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stops reopening after the finite observer retry budget", async () => {
    const openWebSocket = vi.fn(() => {
      const socket = new FakeSocket();
      queueMicrotask(() => socket.close());
      return socket as unknown as WebSocket;
    });
    const fetcher = vi.fn(async () => Response.json({ submissionId: "submission-1", status: "running" }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch: fetcher, openWebSocket });
    await expect(harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" }))
      .rejects.toMatchObject({ retryable: true });
    expect(openWebSocket).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenCalledTimes(4);
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
      socket.send(JSON.stringify({
        type: "submission.status",
        submission: { submissionId: "submission-1", status: "completed" },
      }));
    });
    try {
      const harness = createSpHarness({
        origin: `http://127.0.0.1:${address.port}`,
        serviceToken: "service-secret",
        fetch: async () => Response.json({ submissionId: "submission-1", status: "running" }),
      });
      await expect(harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" }))
        .resolves.toMatchObject({ status: "completed" });
      expect(receivedToken).toBe("service-secret");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects missing evidence rather than reporting an incomplete Subject output", async () => {
    const harness = createSpHarness({
      origin: "https://eval-sp.test",
      serviceToken: "secret",
      fetch: async () => Response.json({ samplingId: "sampling-1", status: "succeeded", artifacts: [] }),
    });
    await expect(harness.collectExecution({ handle: subject })).rejects.toBeInstanceOf(SpHarnessError);
  });
});
