import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EVIDENCE_LIMITS, type JsonValue } from "@eval-platform/eval-contracts";
import {
  AgentHandleNotFoundError,
  AgentIdentityConflictError,
  type AgentHandle,
  type EvidenceBundleReader,
  type ExportedEvidence,
} from "@eval-platform/eval-runtime";
import { EVAL_EVIDENCE_FILE_MAX_BYTES, EVAL_INITIAL_FILE_MAX_BYTES, EVAL_OUTPUT_SCHEMA_PATH as SCHEMA_PATH } from "@springbrand/eval-harness";
import { isRequestCancelled } from "@springbrand/http/errors";
import WebSocket, { WebSocketServer } from "ws";
import { createSpHarness, SpHarnessError, spEvidenceLimits } from "./harness.js";

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
  evaluationId: "evaluation-1",
};
const executionOutput = {
  samplingId: "sampling-1",
  status: "succeeded",
  artifacts: [{ artifactId: "artifact-1", kind: "project", path: "/project" }],
  trajectory: { trajectoryId: "trajectory-1", source: "subject", path: "/trajectory.jsonl" },
};
const readiness = {
  receiptTerminal: true,
  stateUnreadable: false,
  pendingTelemetryEvents: 0,
  pendingRuntimeEvents: 2,
  actionCharges: { complete: false, unsettledExecutions: 1, missingExecutionIds: 0 },
};
const scope = { chatId: SUBJECT_CHAT, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" };
const resources = {
  scope,
  observedAt: "2026-10-14T00:00:00.000Z",
  finalized: true,
  coverage: { usageEvents: "complete", telemetryEvents: "partial", billingSettlements: "complete" },
  usageEvents: [{ eventId: "usage-1", unknownField: null }],
  telemetryEvents: [{ eventId: "event-1" }],
  billingSettlements: [{ eventId: "billing-1", chargedCredits: 7 }],
  readiness,
};
const RESOURCES_PATH = `${CHAT_PATH}/resources/by-key/execution%3Asampling-1`;
const BY_ID_PATH = `${CHAT_PATH}/submissions/submission-1`;
const BY_KEY_PATH = `${CHAT_PATH}/submissions/by-key/execution%3Asampling-1`;
type Ref = { readonly bundleId: string; readonly materialId: string };
const subjectMaterials: readonly Ref[] = [
  { bundleId: "bundle-1", materialId: "material-1" },
  { bundleId: "bundle-2", materialId: "material-2" },
];
const evaluatorMaterials: readonly Ref[] = [
  { bundleId: "eval-bundle", materialId: "judge-brief" },
  { bundleId: "eval-bundle", materialId: "rubric" },
];
const binding = (materials: readonly Ref[] = [], root = "", extra: Record<string, unknown> = {}) => ({
  manifestHash: "hash",
  target: "workspace",
  materials: materials.map((ref) => ({ ...ref, rootPath: `${root}/initial-materials/${ref.bundleId}/${ref.materialId}` })),
  ...extra,
});
/** Each Material resolves to one file named after it. */
const materialFiles = async (_owner: string, { materialId }: Ref) => [
  { path: `/${materialId}.txt`, mediaType: "text/plain", contentBase64: Buffer.from(materialId).toString("base64") },
];

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
    this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" }));
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
    await expect(harness.stopAgent({ handle: subject })).resolves.toBeUndefined();
    expect([requests[0]!.method, requests[0]!.url, requests[0]!.headers.get("X-Eval-Service-Token")]).toEqual([
      "POST", `https://eval-sp.test${CHAT_PATH}/submissions/stop`, "secret",
    ]);
    await expect(harness.stopAgent({ handle: { ...subject, chatId: MISSING_CHAT } })).resolves.toBeUndefined();
    await expect(harness.inspectAgentOperation({
      handle: { ...subject, chatId: MISSING_CHAT }, idempotencyKey: "execution:sampling-1",
    })).rejects.toBeInstanceOf(AgentHandleNotFoundError);
  });

  it("bounds a stuck SP stop request with the stop timeout", async () => {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      // Listen on the caller's signal: a dropped `new Request(...)` clone can be collected and stop following it.
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      signal?.addEventListener("abort", () => reject(signal.reason));
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
        return Response.json(binding(subjectMaterials));
      }
      if (request.method === "POST" && url.pathname.endsWith("/submissions")) return Response.json(receipt("completed"));
      if (request.method === "GET" && url.pathname.includes("/submissions/by-key/")) {
        return Response.json(receipt("completed"));
      }
      if (request.method === "GET" && url.pathname.endsWith("/output")) return Response.json(executionOutput);
      if (request.method === "GET" && url.pathname.includes("/resources/by-key/")) return Response.json(resources);
      throw new Error(`Unexpected ${request.method} ${url}`);
    });
    const resolveInitialMaterials = vi.fn(materialFiles);
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "service-secret", fetch, resolveInitialMaterials });
    expect(await harness.ensureAgent(ensureInput(subject))).toEqual(subject);
    expect(await harness.materializeInitialData({
      handle: subject,
      idempotencyKey: "initial-data:subject-chat",
      data: { userPrompt: "Build a project", initialMaterials: subjectMaterials },
    })).toEqual(binding(subjectMaterials));
    expect(await harness.submitAgent({ handle: subject, idempotencyKey: "execution:sampling-1", prompt: "Build a project" }))
      .toEqual({ submissionId: "submission-1", status: "completed", accepted: true, createdAt: 1 });
    expect((await harness.inspectAgentOperation({ handle: subject, idempotencyKey: "execution:sampling-1" }))?.submissionId)
      .toBe("submission-1");
    expect(await harness.collectExecution({ handle: subject })).toEqual(executionOutput);
    expect(await harness.collectAgentResources({ handle: subject, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" }))
      .toEqual(resources);

    expect(requests).toHaveLength(6);
    expect(requests.every((request) => new URL(request.url).pathname.startsWith(CHAT_PATH))).toBe(true);
    expect(requests.every((request) => request.headers.get("X-Eval-Service-Token") === "service-secret")).toBe(true);
    expect(await requests[0]!.json()).toEqual(ensureInput(subject));
    expect(await requests[1]!.json()).toEqual({
      idempotencyKey: "initial-data:subject-chat",
      data: { userPrompt: "Build a project", initialMaterials: subjectMaterials },
      initialMaterials: subjectMaterials.map((ref) => ({ ...ref, files: [
        { path: `/${ref.materialId}.txt`, mediaType: "text/plain", contentBase64: Buffer.from(ref.materialId).toString("base64") },
      ] })),
    });
    expect(resolveInitialMaterials.mock.calls).toEqual(subjectMaterials.map((ref) => [OWNER, ref]));
    expect(await requests[2]!.json()).toEqual({ idempotencyKey: "execution:sampling-1", prompt: "Build a project", unattended: true });
    expect(new URL(requests[5]!.url).searchParams.get("submissionId")).toBe("submission-1");
  });

  it.each([subject, evaluator])("preserves $role Prompt text and business fields across initialization and submission", async (handle) => {
    const prompt = "\t\r\nBuild a project\nPreserve formatting.\u00a0\u3000";
    const data = { userPrompt: prompt, sampleId: { source: "dataset", index: 0 }, metadata: { enabled: false } };
    const outputSchema = handle.role === "evaluator" ? { type: "object" } : undefined;
    const materialized = binding([], "", outputSchema ? { evaluationOutputSchemaPath: SCHEMA_PATH } : {});
    const { fetch, requests } = queuedFetch(Response.json(materialized), Response.json(receipt("completed")));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    const chatPath = `/internal/v1/eval-harness/users/${OWNER}/chats/${handle.chatId}`;

    await expect(harness.materializeInitialData({
      handle, idempotencyKey: "initial-data:prompt", data,
      ...(outputSchema ? { evaluationOutputSchema: outputSchema } : {}),
    })).resolves.toEqual(materialized);
    await expect(harness.submitAgent({
      handle, idempotencyKey: "submission:prompt", prompt,
    })).resolves.toMatchObject({ submissionId: "submission-1", status: "completed" });

    expect(requests).toHaveLength(2);
    expect(new URL(requests[0]!.url).pathname).toBe(`${chatPath}/initialization`);
    expect(await requests[0]!.json()).toMatchObject({ idempotencyKey: "initial-data:prompt", data });
    expect(new URL(requests[1]!.url).pathname).toBe(`${chatPath}/submissions`);
    expect(await requests[1]!.json()).toEqual({ idempotencyKey: "submission:prompt", prompt, unattended: true });
  });

  it.each(["", " \t\r\n\u00a0\u3000"])("rejects blank Prompt %j in initialization and submission before contacting SP", async (prompt) => {
    const fetch = vi.fn();
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.materializeInitialData({
      handle: subject, idempotencyKey: "initial-data:prompt", data: { userPrompt: prompt },
    })).rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
    await expect(harness.submitAgent({
      handle: subject, idempotencyKey: "submission:prompt", prompt,
    })).rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ensures an evaluator Chat with only its Evaluation ID and reads the result from its own Space", async () => {
    const { fetch, requests } = spFetch((request) => new URL(request.url).pathname.endsWith("/output")
      ? Response.json({
        status: "succeeded",
        artifacts: [{ artifactId: "judge-output", kind: "evaluation", path: "/output/result.json" }],
        structuredOutput: { path: "/output/result.json", content: '{ "score": 1.50 }', contentHash: "sha256:abc" },
        trajectory: { trajectoryId: "judge-trace", source: "evaluator", path: `/api/chats/${EVALUATOR_CHAT}/trajectory` },
        unknownField: { kept: false },
      })
      : Response.json(evaluator));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    expect(await harness.ensureAgent(ensureInput(evaluator))).toEqual(evaluator);
    expect(await requests[0]!.json()).toEqual(ensureInput(evaluator));
    const output = await harness.collectEvaluation({ handle: evaluator });
    expect(output.trajectory.source).toBe("evaluator");
    expect(output.structuredOutput).toEqual({
      path: "/output/result.json", content: '{ "score": 1.50 }', contentHash: "sha256:abc",
    });
    expect(output).not.toHaveProperty("unknownField");
    expect(new URL(requests[1]!.url).searchParams.get("evaluationId")).toBe("evaluation-1");
  });

  it("rejects a request that violates the SP contract before contacting SP", async () => {
    const fetch = vi.fn();
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    const { evaluationId: _evaluationId, ...unbound } = ensureInput(evaluator);
    await expect(harness.ensureAgent(unbound))
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
    await expect(harness.ensureAgent({ ...ensureInput(subject), chatId: "not-a-uuid" }))
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
    await expect(harness.submitAgent({ handle: subject, idempotencyKey: "execution:sampling-1", prompt: "  " }))
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[[]], [evaluatorMaterials]] as const)(
    "sends the Project JSON Schema beside evaluator materials %j and no synthetic material",
    async (materials) => {
      const { fetch, requests } = spFetch(() => Response.json(binding(materials, "",
        { evaluationOutputSchemaPath: SCHEMA_PATH })));
      const resolveInitialMaterials = vi.fn(materialFiles);
      const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, resolveInitialMaterials });
      const schema = { type: "object", properties: { score: { type: "number" } } };
      const materialized = await harness.materializeInitialData({
        handle: evaluator, idempotencyKey: "initial-data:evaluator-chat",
        data: { userPrompt: "Judge", ...(materials.length ? { initialMaterials: materials } : {}) },
        evaluationOutputSchema: schema,
      });
      expect(materialized).toEqual(binding(materials, "", { evaluationOutputSchemaPath: SCHEMA_PATH }));
      const body = await requests[0]!.json();
      expect(JSON.parse(body.evaluationOutputSchema.content)).toEqual(schema);
      expect(body.initialMaterials?.map(({ bundleId, materialId }: Ref) => ({ bundleId, materialId })))
        .toEqual(materials.length ? materials : undefined);
      expect(body.data.initialMaterials).toEqual(materials.length ? materials : undefined);
      expect(resolveInitialMaterials.mock.calls).toEqual(materials.map((ref) => [OWNER, ref]));
    },
  );

  it("sends the output Schema only for an Evaluator", async () => {
    const fetch = vi.fn();
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.materializeInitialData({ handle: evaluator, idempotencyKey: "missing",
      data: { userPrompt: "Judge" } })).rejects.toMatchObject({ retryable: false });
    await expect(harness.materializeInitialData({ handle: subject, idempotencyKey: "extra",
      data: { userPrompt: "Build" }, evaluationOutputSchema: { type: "object" } })).rejects.toMatchObject({ retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects initialization files over SP's total budget before contacting SP", async () => {
    const fetch = vi.fn();
    const large = Buffer.alloc(EVAL_INITIAL_FILE_MAX_BYTES).toString("base64");
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch,
      resolveInitialMaterials: async (_owner, { materialId }) => Array.from({ length: 2 }, (_, index) => ({
        path: `/${materialId}-${index}.bin`, mediaType: "application/octet-stream", contentBase64: large,
      })) });
    const materials = [...subjectMaterials, { bundleId: "bundle-3", materialId: "material-3" }];
    await expect(harness.materializeInitialData({ handle: subject, idempotencyKey: "too-large",
      data: { userPrompt: "Build", initialMaterials: materials } })).rejects.toMatchObject({ retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an initialization result outside SP's contract", async () => {
    const { fetch } = queuedFetch(Response.json({ bundleId: "bundle-1", manifestHash: "hash", target: "workspace", rootPath: "/" }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.materializeInitialData({ handle: subject, idempotencyKey: "init", data: { userPrompt: "Build" } }))
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
  });

  it("does not submit a material reference without its per-Sample files", async () => {
    const fetch = vi.fn();
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.materializeInitialData({
      handle: subject,
      idempotencyKey: "initial-data:subject-chat",
      data: { userPrompt: "Build a project", initialMaterials: subjectMaterials },
    })).rejects.toMatchObject({ retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("includes canonical Session content when a resolver supplies it", async () => {
    const { fetch, requests } = spFetch(() => Response.json(binding()));
    const resolveInitialSession = vi.fn(async () => ({
      format: "jsonl" as const,
      content: '{"id":"m1","message":{"role":"user","content":"Hi","timestamp":1},"createdAt":1}',
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

  it("does not initialize a referenced Context without its resolver", async () => {
    const { fetch, requests } = spFetch(() => Response.json(binding()));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.materializeInitialData({
      handle: subject, idempotencyKey: "init-missing-context",
      data: { userPrompt: "Continue", initialSession: { bundleId: "sessions", sessionId: "seed" } },
    })).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("context bundle resolver") });
    expect(requests).toHaveLength(0);
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
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
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

  it("exports Subject artifacts within limits and its complete trajectory, page by page", async () => {
    const event = (ingestSeq: number, type: string, payload: Record<string, unknown>) => ({
      ingestSeq,
      event: {
        schemaVersion: 1, type, eventId: `event-${ingestSeq}`, operationId: `operation-${ingestSeq}`,
        submissionId: "submission-1", occurredAt: 1_760_000_000_000 + ingestSeq,
        resource: { sessionId: SUBJECT_CHAT, agentName: "severn", agentId: "agent", serviceName: "sp" }, payload,
      },
    });
    const { fetch, requests } = spFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/evidence/artifacts")) {
        return Response.json({ artifacts: [
          { path: "/index.html", size: 11, mediaType: "text/html" },
          { path: "/node_modules/x/index.js", size: 1, mediaType: "text/javascript" },
          { path: "/video.mp4", size: EVAL_EVIDENCE_FILE_MAX_BYTES + 1, mediaType: "video/mp4" },
        ] });
      }
      if (url.pathname.endsWith("/evidence/trajectory")) {
        return url.searchParams.get("afterSeq") === "0"
          ? Response.json({ events: [event(1, "turn.admitted", { prompt: "Build" }), event(2, "tool.started", { toolName: "write", input: { path: "/index.html" } })], nextAfterSeq: 2 })
          : Response.json({ events: [event(3, "context.compacted", { removedMessages: 3 })], nextAfterSeq: null });
      }
      if (url.pathname.endsWith("/evidence/files")) return new Response("<h1>Hi</h1>", { headers: { "Content-Type": "text/html" } });
      throw new Error(`Unexpected ${request.method} ${url}`);
    });
    const logged: Record<string, unknown>[] = [];
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, log: (event) => logged.push(event) });
    const exported = await harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits: DEFAULT_EVIDENCE_LIMITS });

    expect(exported.source).toEqual({ framework: "sp", samplingId: "sampling-1", agentRef: { ownerUserId: OWNER, chatId: SUBJECT_CHAT } });
    expect(exported.artifacts).toEqual([{ path: "/index.html", size: 11, mediaType: "text/html" }]);
    expect(exported.omitted).toEqual([
      { path: "/node_modules/x/index.js", reason: "excluded" },
      { path: "/video.mp4", reason: "too-large" },
    ]);
    expect(exported.trajectoryComplete).toBe(true);
    await expect(new Response(await exported.readFile("/index.html")).text()).resolves.toBe("<h1>Hi</h1>");
    const events: { seq: number; record: JsonValue }[] = [];
    for await (const item of exported.readTrajectory(0)) events.push(item);
    expect(events).toEqual([
      { seq: 1, record: event(1, "turn.admitted", { prompt: "Build" }) },
      { seq: 2, record: event(2, "tool.started", { toolName: "write", input: { path: "/index.html" } }) },
      { seq: 3, record: event(3, "context.compacted", { removedMessages: 3 }) },
    ]);
    // Successful file reads and intermediate pages are summarized by Runtime; only the final page is logged.
    expect(logged).toEqual([expect.objectContaining({ name: "evidence_trajectory_page", status: 200, from: 0, pages: 2, events: 3, afterSeq: 2 })]);
    expect(JSON.stringify(logged)).not.toContain("Build");
    const fileRequest = requests.find((request) => new URL(request.url).pathname.endsWith("/evidence/files"))!;
    expect(new URL(fileRequest.url).searchParams.get("path")).toBe("/index.html");
    // Every export read names its Submission.
    const exportReads = requests.filter((request) => new URL(request.url).pathname.includes("/evidence/"));
    expect(exportReads.map((request) => new URL(request.url).searchParams.get("submissionId")))
      .toEqual(exportReads.map(() => "submission-1"));

    // A resumed read starts at the persisted cursor and yields exactly the remaining events.
    requests.length = 0;
    const resumed: { seq: number; record: JsonValue }[] = [];
    for await (const item of exported.readTrajectory(2)) resumed.push(item);
    expect(resumed).toEqual(events.slice(2));
    expect(requests.map((request) => new URL(request.url).searchParams.get("afterSeq"))).toEqual(["2"]);
    await expect((async () => { for await (const _ of exported.readTrajectory(-1)) { /* never reached */ } })())
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
    expect(requests.every((request) => request.headers.get("X-Eval-Service-Token") === "secret")).toBe(true);
    expect(requests.every((request) => new URL(request.url).pathname.startsWith(CHAT_PATH))).toBe(true);
    // SP without a cursor: no pin, no `throughSeq`, and the default format, exactly as before pinning.
    expect(exported.trajectoryFormat).toBe("sp-trajectory/v1");
    expect(exported).not.toHaveProperty("trajectoryCursor");
    expect(requests.some((request) => new URL(request.url).searchParams.has("throughSeq"))).toBe(false);
  });

  describe("pinned evidence trajectory", () => {
    const TRAJECTORY_PATH = `${CHAT_PATH}/evidence/trajectory`;
    const entry = (ingestSeq: number) => ({ ingestSeq, event: { type: "raw", eventId: `event-${ingestSeq}` } });
    /** SP pins `throughSeq: 3` on a page requested without one and echoes the requested one otherwise. */
    const pinningSp = (overrides: (url: URL) => Record<string, unknown> = () => ({})) => spFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/evidence/artifacts")) return Response.json({ artifacts: [] });
      if (url.pathname !== TRAJECTORY_PATH) throw new Error(`Unexpected ${request.method} ${url}`);
      const afterSeq = Number(url.searchParams.get("afterSeq"));
      const throughSeq = Number(url.searchParams.get("throughSeq") ?? 3);
      const events = [1, 2, 3].filter((seq) => seq > afterSeq && seq <= throughSeq).slice(0, 2).map(entry);
      const last = events.at(-1)?.ingestSeq;
      return Response.json({
        events, nextAfterSeq: last === undefined || last === throughSeq ? null : last,
        format: "sp-trajectory/v1", cursor: { throughSeq }, ...overrides(url),
      });
    });
    const trajectoryQueries = (requests: readonly Request[]) => requests
      .map((request) => new URL(request.url)).filter((url) => url.pathname === TRAJECTORY_PATH)
      .map((url) => Object.fromEntries(url.searchParams));
    const readAll = async (exported: ExportedEvidence, afterSeq = 0) => {
      const seqs: number[] = [];
      for await (const item of exported.readTrajectory(afterSeq)) seqs.push(item.seq);
      return seqs;
    };
    const exportInput = { handle: subject, submissionId: "submission-1", limits: DEFAULT_EVIDENCE_LIMITS };

    it("pins the cursor on the first page and sends it with every later page", async () => {
      const { fetch, requests } = pinningSp();
      const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
      const exported = await harness.exportEvidence(exportInput);
      expect(exported.trajectoryCursor).toEqual({ throughSeq: 3 });
      expect(exported.trajectoryFormat).toBe("sp-trajectory/v1");
      expect(trajectoryQueries(requests)).toEqual([{ afterSeq: "0", limit: "200", submissionId: "submission-1" }]);

      requests.length = 0;
      await expect(readAll(exported)).resolves.toEqual([1, 2, 3]);
      // The pinning page is not read twice; the next page carries the pinned cutoff.
      expect(trajectoryQueries(requests)).toEqual([{ afterSeq: "2", limit: "200", submissionId: "submission-1", throughSeq: "3" }]);
      requests.length = 0;
      await expect(readAll(exported)).resolves.toEqual([1, 2, 3]);
      expect(trajectoryQueries(requests).map((query) => query.throughSeq)).toEqual(["3", "3"]);
    });

    it("takes the export's format from the first page", async () => {
      const { fetch } = pinningSp(() => ({ format: "sp-trajectory/v2" }));
      const exported = await createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch }).exportEvidence(exportInput);
      expect(exported.trajectoryFormat).toBe("sp-trajectory/v2");
      await expect(readAll(exported)).resolves.toEqual([1, 2, 3]);
    });

    it.each([
      { name: "a different cursor", change: { cursor: { throughSeq: 4 } } },
      { name: "no cursor", change: { cursor: undefined } },
      { name: "a different format", change: { format: "pi-trajectory/v1" } },
      { name: "no format", change: { format: undefined } },
    ])("rejects a later page with $name", async ({ change }) => {
      // The export is pinned to a non-default format, so a page without one differs too; `undefined` drops the field.
      const { fetch } = pinningSp((url) => ({ format: "pi-trajectory/v0", ...(url.searchParams.has("throughSeq") ? change : {}) }));
      const exported = await createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch }).exportEvidence(exportInput);
      await expect(readAll(exported)).rejects.toMatchObject({ name: "SpHarnessError", retryable: false, message: expect.stringMatching(/changed the evidence trajectory/u) });
    });

    it.each([
      { name: "an event beyond the cutoff", page: { events: [entry(1), entry(4)], nextAfterSeq: null, cursor: { throughSeq: 3 } } },
      { name: "a next cursor beyond the cutoff", page: { events: [entry(4)], nextAfterSeq: 4, cursor: { throughSeq: 3 } } },
      { name: "a non-positive cutoff", page: { events: [], nextAfterSeq: null, cursor: { throughSeq: 0 } } },
      { name: "an empty format", page: { events: [], nextAfterSeq: null, format: "" } },
    ])("rejects a page with $name", async ({ page }) => {
      const { fetch } = queuedFetch(Response.json({ artifacts: [] }), Response.json(page));
      await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch }).exportEvidence(exportInput))
        .rejects.toMatchObject({ name: "SpHarnessError", retryable: false, message: "Eval SP returned an invalid evidence trajectory page" });
    });

    it("resumes with the saved pin without pinning again", async () => {
      const { fetch, requests } = pinningSp();
      const exported = await createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
        .exportEvidence({ ...exportInput, trajectory: { format: "sp-trajectory/v1", cursor: { throughSeq: 2 } } });
      expect(exported.trajectoryCursor).toEqual({ throughSeq: 2 });
      expect(trajectoryQueries(requests)).toEqual([]);
      await expect(readAll(exported, 1)).resolves.toEqual([2]);
      expect(trajectoryQueries(requests)).toEqual([{ afterSeq: "1", limit: "200", submissionId: "submission-1", throughSeq: "2" }]);
    });

    it("continues progress saved before pinning without a cursor, ignoring cursors SP now returns", async () => {
      const { fetch, requests } = pinningSp((url) => ({ cursor: { throughSeq: url.searchParams.get("afterSeq") === "0" ? 3 : 7 } }));
      const exported = await createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch })
        .exportEvidence({ ...exportInput, trajectory: {} });
      expect(exported.trajectoryFormat).toBe("sp-trajectory/v1");
      expect(exported).not.toHaveProperty("trajectoryCursor");
      await expect(readAll(exported)).resolves.toEqual([1, 2, 3]);
      expect(trajectoryQueries(requests).some((query) => "throughSeq" in query)).toBe(false);
    });
  });

  it("imports every evidence file into the Evaluator's own Space, manifest last", async () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const content: Record<string, string> = { [sha("<h1>Hi</h1>")]: "<h1>Hi</h1>", [sha("{}\n")]: "{}\n" };
    const manifestBytes = new TextEncoder().encode('{"manifest":true}');
    const evidence = {
      ref: { evidenceId: `sha256:${"a".repeat(64)}`, manifestSha256: sha('{"manifest":true}'), exportedAt: "2026-10-15T00:00:00.000Z" },
      manifestBytes,
      manifest: {
        artifacts: [{ path: "/site/index.html", size: 11, mediaType: "text/html", sha256: sha("<h1>Hi</h1>") }],
        subjectInputs: [],
        trajectory: { parts: [{ sha256: sha("{}\n"), size: 3, events: 1 }] },
      },
      readBlob: async (hash: string) => new Response(content[hash]).body!,
    } as unknown as EvidenceBundleReader;
    const { fetch, requests } = spFetch(async (request) => {
      const body = new Uint8Array(await request.arrayBuffer());
      return Response.json({
        path: `/evidence${new URL(request.url).searchParams.get("path")}`,
        size: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
      });
    });
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await harness.importEvidence({ handle: evaluator, idempotencyKey: "evidence:x:evaluation-1", evidence, root: "/evidence" });

    const writes = requests.map((request) => [request.method, new URL(request.url).pathname,
      new URL(request.url).searchParams.get("path"), request.headers.get("X-Eval-Content-Sha256")]);
    expect(writes).toHaveLength(3);
    // Evidence files upload concurrently; only the manifest must follow every file.
    expect(writes.slice(0, -1)).toEqual(expect.arrayContaining([
      ["PUT", `/internal/v1/eval-harness/users/${OWNER}/chats/${EVALUATOR_CHAT}/evidence/files`, "/artifacts/site/index.html", sha("<h1>Hi</h1>")],
      ["PUT", `/internal/v1/eval-harness/users/${OWNER}/chats/${EVALUATOR_CHAT}/evidence/files`, "/trajectory/events-000001.jsonl", sha("{}\n")],
    ]));
    expect(writes.at(-1)).toEqual(
      ["PUT", `/internal/v1/eval-harness/users/${OWNER}/chats/${EVALUATOR_CHAT}/evidence/files`, "/manifest.json", sha('{"manifest":true}')],
    );
    await expect(harness.importEvidence({ handle: subject, idempotencyKey: "x", evidence, root: "/evidence" }))
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: false });
  });

  it("treats a rejected evidence write as retryable only for transient SP statuses", async () => {
    const evidence = {
      ref: { evidenceId: `sha256:${"a".repeat(64)}`, manifestSha256: "b".repeat(64), exportedAt: "x" },
      manifestBytes: new TextEncoder().encode("manifest"),
      manifest: { artifacts: [], subjectInputs: [], trajectory: { parts: [] } },
      readBlob: async () => new Response("").body!,
    } as unknown as EvidenceBundleReader;
    Object.assign(evidence.ref, { manifestSha256: createHash("sha256").update(evidence.manifestBytes).digest("hex") });
    for (const [status, retryable] of [[503, true], [409, false]] as const) {
      const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret",
        fetch: queuedFetch(new Response("no", { status })).fetch });
      await expect(harness.importEvidence({ handle: evaluator, idempotencyKey: "k", evidence, root: "/evidence" }))
        .rejects.toMatchObject({ name: "SpHarnessError", retryable, status });
    }
  });
});

describe("Eval SP Harness large transfers and readiness", () => {
  const notReady = () => Response.json({ code: "EVIDENCE_NOT_READY", errMsg: "Telemetry is still being delivered" },
    { status: 409, headers: { "Retry-After": "3" } });

  it.each(["collectAgentResources", "inspectAgentResources"] as const)("physically cancels the streamed body of %s and preserves cancellation", async (method) => {
    const stop = new AbortController();
    let active = 0;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      active += 1;
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          controller = stream;
          stream.enqueue(new TextEncoder().encode('{"scope":'));
          signal?.addEventListener("abort", () => {
            active -= 1;
            stream.error(signal.reason);
          }, { once: true });
        },
        pull() { started(); },
      });
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    });
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    const result = harness[method]({
      handle: subject, idempotencyKey: "execution:sampling-1", submissionId: "submission-1", signal: stop.signal,
    }).catch((error: unknown) => error);
    try {
      await reading;
      stop.abort();
      await vi.waitFor(() => expect(active).toBe(0));
      const error = await result;
      expect(isRequestCancelled(error)).toBe(true);
      expect(error).not.toBeInstanceOf(SpHarnessError);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      controller.error(new Error("test cleanup"));
      await result;
    }
  });

  it.each(["collectAgentResources", "inspectAgentResources"] as const)("does not start %s with an already aborted signal", async (method) => {
    const fetch = vi.fn(async () => Response.json(resources));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    const error = await harness[method]({
      handle: subject, idempotencyKey: "execution:sampling-1", signal: AbortSignal.abort(),
    }).catch((cause: unknown) => cause);
    expect(isRequestCancelled(error)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes SP's resource readiness through and reports the read without payload contents", async () => {
    const events: Record<string, unknown>[] = [];
    const { fetch } = queuedFetch(Response.json(resources));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "service-secret", fetch,
      log: (event) => events.push(event) });
    expect(await harness.collectAgentResources({ handle: subject, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" }))
      .toEqual(resources);
    expect(events).toEqual([expect.objectContaining({
      name: "resources_read", status: 200, finalized: true, submissionId: "submission-1", readiness, telemetryEvents: 1,
    })]);
    expect(JSON.stringify(events)).not.toContain("service-secret");
    expect(JSON.stringify(events)).not.toContain("event-1");
  });

  it.each([
    ["an invalid", { ...resources, readiness: { ...readiness, pendingTelemetryEvents: -1 } }],
    ["a missing", (({ readiness: _readiness, ...rest }) => rest)(resources)],
  ])("rejects %s readiness summary instead of persisting the snapshot", async (_case, body) => {
    const { fetch } = queuedFetch(Response.json(body));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.collectAgentResources({ handle: subject, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" }))
      .rejects.toMatchObject({ retryable: false, message: "Eval SP returned an invalid resource snapshot" });
  });

  it("inspects resource readiness on its own route with the control timeout, without events", async () => {
    const report = { scope, observedAt: "2026-10-14T00:00:00.000Z", finalized: false, readiness };
    const events: Record<string, unknown>[] = [];
    const { fetch, requests } = queuedFetch(Response.json({ ...report, telemetryEvents: [{ eventId: "event-1" }] }), Response.json(report));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, log: (event) => events.push(event) });
    const input = { handle: subject, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" };
    expect(await harness.inspectAgentResources(input)).toEqual(report);
    expect(await harness.inspectAgentResources({ handle: subject, idempotencyKey: "execution:sampling-1" })).toEqual(report);
    expect(requests.map((request) => `${new URL(request.url).pathname}${new URL(request.url).search}`)).toEqual([
      `${RESOURCES_PATH}/readiness?submissionId=submission-1`, `${RESOURCES_PATH}/readiness`,
    ]);
    expect(events[0]).toMatchObject({ name: "resources_readiness", status: 200, finalized: false, readiness });
  });

  it("logs SP's request ID with a failed JSON read for cross-system correlation", async () => {
    const events: Record<string, unknown>[] = [];
    const { fetch } = queuedFetch(Response.json({ code: "INTERNAL_ERROR", errMsg: "unavailable" },
      { status: 503, headers: { "X-Request-ID": "sp-request-2" } }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, log: (event) => events.push(event) });
    await expect(harness.inspectAgentResources({ handle: subject, idempotencyKey: "execution:sampling-1" }))
      .rejects.toMatchObject({ retryable: true, status: 503, requestId: "sp-request-2" });
    expect(events).toEqual([expect.objectContaining({ name: "resources_readiness", status: 503, retryable: true, requestId: "sp-request-2" })]);
  });

  it.each([
    { ...resources, readiness: { ...readiness, actionCharges: { complete: true } } },
    { scope, observedAt: "2026-10-14T00:00:00.000Z", finalized: false },
    { scope: { ...scope, submissionId: "" }, observedAt: "x", finalized: true, readiness },
  ])("rejects a readiness report outside SP's contract", async (body) => {
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch: queuedFetch(Response.json(body)).fetch });
    await expect(harness.inspectAgentResources({ handle: subject, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" }))
      .rejects.toMatchObject({ retryable: false, message: "Eval SP returned an invalid resource readiness" });
  });

  it("fails an oversized resource snapshot explicitly and permanently", async () => {
    const { fetch } = queuedFetch(Response.json({ ...resources, telemetryEvents: [{ payload: "x".repeat(2_048) }] }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, maxResponseBytes: 1_024 });
    await expect(harness.collectAgentResources({ handle: subject, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" }))
      .rejects.toMatchObject({
        name: "SpHarnessError", retryable: false,
        message: "Eval SP resource snapshot exceeded the 1024-byte response limit",
      });
  });

  it("retries a resource snapshot whose stream was cut off mid-body", async () => {
    const full = new TextEncoder().encode(JSON.stringify(resources));
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(full.slice(0, full.length / 2));
        controller.error(new TypeError("terminated"));
      },
    });
    const { fetch } = queuedFetch(new Response(cut, { headers: { "Content-Type": "application/json" } }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.collectAgentResources({ handle: subject, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" }))
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: true });
  });

  it("uses the large-transfer timeout for resources and evidence, and the short timeout elsewhere", async () => {
    const hang = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      signal?.addEventListener("abort", () => reject(signal.reason));
    }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch: hang,
      requestTimeoutMs: 5, transferTimeoutMs: 60 });
    const started = Date.now();
    await expect(harness.inspectAgentOperation({ handle: subject, idempotencyKey: "execution:sampling-1" }))
      .rejects.toMatchObject({ retryable: true });
    expect(Date.now() - started).toBeLessThan(55);
    const readinessStarted = Date.now();
    await expect(harness.inspectAgentResources({ handle: subject, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" }))
      .rejects.toMatchObject({ retryable: true });
    expect(Date.now() - readinessStarted).toBeLessThan(55);
    const resourceStarted = Date.now();
    await expect(harness.collectAgentResources({ handle: subject, idempotencyKey: "execution:sampling-1", submissionId: "submission-1" }))
      .rejects.toMatchObject({ retryable: true });
    expect(Date.now() - resourceStarted).toBeGreaterThanOrEqual(55);
  });

  it("retries an evidence read only while SP reports EVIDENCE_NOT_READY", async () => {
    const { fetch } = queuedFetch(
      notReady(),
      notReady(),
      Response.json({ code: "REQUEST_CONFLICT", errMsg: "Submission is still running" }, { status: 409 }),
      new Response(null, { status: 409 }),
    );
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.exportEvidence({ handle: subject, submissionId: "submission-1", limits: DEFAULT_EVIDENCE_LIMITS })).rejects.toMatchObject({
      name: "SpHarnessError", retryable: true, status: 409, retryAfterMs: 3_000,
    });
    const emptyPage = () => Response.json({ events: [], nextAfterSeq: null });
    await expect(createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret",
      fetch: queuedFetch(Response.json({ artifacts: [] }), notReady()).fetch })
      .exportEvidence({ handle: subject, submissionId: "submission-1", limits: DEFAULT_EVIDENCE_LIMITS }))
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: true, status: 409 });
    const exported = (await createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret",
      fetch: queuedFetch(Response.json({ artifacts: [] }), emptyPage()).fetch }).exportEvidence({ handle: subject, submissionId: "submission-1", limits: DEFAULT_EVIDENCE_LIMITS }));
    expect(exported.artifacts).toEqual([]);
    const fileHarness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret",
      fetch: queuedFetch(Response.json({ artifacts: [] }), emptyPage(), notReady(),
        Response.json({ code: "REQUEST_CONFLICT", errMsg: "conflict" }, { status: 409 })).fetch });
    const files = await fileHarness.exportEvidence({ handle: subject, submissionId: "submission-1", limits: DEFAULT_EVIDENCE_LIMITS });
    await expect(files.readFile("/index.html")).rejects.toMatchObject({ retryable: true, status: 409, retryAfterMs: 3_000 });
    await expect(files.readFile("/index.html")).rejects.toMatchObject({ retryable: false, status: 409 });
    const reply = { handle: evaluator, submissionId: "evaluation-submission" };
    await expect(harness.readFinalReply(reply)).rejects.toMatchObject({ retryable: true, status: 409 });
    await expect(harness.readFinalReply(reply)).rejects.toMatchObject({ retryable: false, status: 409 });
    await expect(harness.readFinalReply(reply)).rejects.toMatchObject({ retryable: false, status: 409 });
  });

  it("never retries a rejected evidence write, even one labelled EVIDENCE_NOT_READY", async () => {
    const evidence = {
      ref: { evidenceId: `sha256:${"a".repeat(64)}`, manifestSha256: "", exportedAt: "x" },
      manifestBytes: new TextEncoder().encode("manifest"),
      manifest: { artifacts: [], subjectInputs: [], trajectory: { parts: [] } },
      readBlob: async () => new Response("").body!,
    } as unknown as EvidenceBundleReader;
    Object.assign(evidence.ref, { manifestSha256: createHash("sha256").update(evidence.manifestBytes).digest("hex") });
    const events: Record<string, unknown>[] = [];
    const rejected = Response.json({ code: "EVIDENCE_NOT_READY", errMsg: "not ready" },
      { status: 409, headers: { "X-Request-ID": "sp-request-1", "cf-ray": "ray-1" } });
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch: queuedFetch(rejected).fetch,
      log: (event) => events.push(event) });
    await expect(harness.importEvidence({ handle: evaluator, idempotencyKey: "k", evidence, root: "/evidence" }))
      .rejects.toMatchObject({ retryable: false, status: 409, requestId: "sp-request-1", cfRay: "ray-1" });
    expect(events).toEqual([
      expect.objectContaining({ name: "evidence_file", direction: "write", status: 409, requestId: "sp-request-1", cfRay: "ray-1" }),
      expect.objectContaining({
        name: "evidence_import", evaluationId: "evaluation-1", filesStored: 0, filesTotal: 1, bytes: 8, outcome: "failed",
        status: 409, requestId: "sp-request-1", cfRay: "ray-1", durationMs: expect.any(Number),
      }),
    ]);
  });

  it("streams evidence blobs to SP instead of buffering them, and rejects bytes that differ from the manifest", async () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const manifestBytes = new TextEncoder().encode("{}");
    const evidenceWith = (stored: string) => ({
      ref: { evidenceId: `sha256:${"a".repeat(64)}`, manifestSha256: sha("{}"), exportedAt: "x" },
      manifestBytes,
      manifest: {
        artifacts: [{ path: "/a.txt", size: 5, mediaType: "text/plain", sha256: sha("hello") }],
        subjectInputs: [],
        trajectory: { parts: [] },
      },
      readBlob: async () => new Response(stored).body!,
    }) as unknown as EvidenceBundleReader;
    const bodies: unknown[] = [];
    const duplex: unknown[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body);
      duplex.push((init as { duplex?: unknown } | undefined)?.duplex);
      const bytes = new Uint8Array(await new Request(input, init).arrayBuffer());
      return Response.json({ path: `/evidence${new URL(String(input)).searchParams.get("path")}`, size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex") });
    });
    const events: Record<string, unknown>[] = [];
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, log: (event) => events.push(event) });
    await harness.importEvidence({ handle: evaluator, idempotencyKey: "k", evidence: evidenceWith("hello"), root: "/evidence" });
    expect(events).toEqual([{
      name: "evidence_import", role: "evaluator", chatId: evaluator.chatId, samplingId: evaluator.samplingId, evaluationId: evaluator.evaluationId,
      evidenceId: `sha256:${"a".repeat(64)}`, filesStored: 2, filesTotal: 2, bytes: 7, durationMs: expect.any(Number), outcome: "stored",
    }]);
    expect(bodies[0]).toBeInstanceOf(ReadableStream);
    expect(duplex[0]).toBe("half");
    fetch.mockClear();
    await expect(harness.importEvidence({ handle: evaluator, idempotencyKey: "k", evidence: evidenceWith("HELLO"), root: "/evidence" }))
      .rejects.toMatchObject({ name: "SpHarnessError", retryable: false, message: "Evidence bytes do not match the import contract for /artifacts/a.txt" });
    const oversized = evidenceWith("hello");
    Object.assign(oversized.manifest.artifacts[0]!, { size: 1 + EVAL_EVIDENCE_FILE_MAX_BYTES });
    fetch.mockClear();
    await expect(harness.importEvidence({ handle: evaluator, idempotencyKey: "k", evidence: oversized, root: "/evidence" }))
      .rejects.toMatchObject({ retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds every evidence file, trajectory parts included, by SP's file limit", () => {
    expect(spEvidenceLimits(DEFAULT_EVIDENCE_LIMITS)).toEqual({ ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes: EVAL_EVIDENCE_FILE_MAX_BYTES });
    const smaller = { ...DEFAULT_EVIDENCE_LIMITS, maxFileBytes: 1_000 };
    expect(spEvidenceLimits(smaller)).toEqual(smaller);
  });

  it("refuses, before writing anything, a bundle with a file larger than SP can import", async () => {
    // Only a bundle stored under limits larger than SP's can hold such a part.
    const evidence = {
      ref: { evidenceId: `sha256:${"a".repeat(64)}`, manifestSha256: "b".repeat(64), exportedAt: "x" },
      manifestBytes: new TextEncoder().encode("{}"),
      manifest: {
        artifacts: [{ path: "/a.txt", size: 5, mediaType: "text/plain", sha256: "c".repeat(64) }],
        subjectInputs: [],
        trajectory: { parts: [{ sha256: "d".repeat(64), size: 1, events: 1 }, { sha256: "e".repeat(64), size: EVAL_EVIDENCE_FILE_MAX_BYTES + 1, events: 1 }] },
      },
      readBlob: async () => new Response("").body!,
    } as unknown as EvidenceBundleReader;
    const fetch = vi.fn(async () => new Response(null, { status: 500 }));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch });
    await expect(harness.importEvidence({ handle: evaluator, idempotencyKey: "k", evidence, root: "/evidence" })).rejects.toMatchObject({
      name: "SpHarnessError",
      retryable: false,
      message: `Evidence file /trajectory/events-000002.jsonl is ${EVAL_EVIDENCE_FILE_MAX_BYTES + 1} bytes, above SP's ${EVAL_EVIDENCE_FILE_MAX_BYTES}-byte evidence file limit; the bundle cannot be imported`,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Eval SP Submission observation after a dropped socket", () => {
  function sockets() {
    const opened: FakeSocket[] = [];
    const openWebSocket = vi.fn((_url: string, _headers: Readonly<Record<string, string>>) => {
      const socket = new FakeSocket();
      opened.push(socket);
      return socket as unknown as WebSocket;
    });
    return { opened, openWebSocket };
  }

  it("reads the known Submission by ID and reconnects the same URL while it is still running", async () => {
    const { opened, openWebSocket } = sockets();
    const events: Record<string, unknown>[] = [];
    const { fetch, requests } = queuedFetch(Response.json(receipt("running")), Response.json(receipt("running")));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, openWebSocket,
      log: (event) => events.push(event) });
    const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
    opened[0]!.close();
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledTimes(2));
    opened[1]!.sendStatus(receipt("completed"));
    await expect(waiting).resolves.toMatchObject({ status: "completed" });
    expect(openWebSocket.mock.calls[1]![0]).toBe(openWebSocket.mock.calls[0]![0]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([BY_KEY_PATH, BY_ID_PATH]);
    expect(events.map((event) => event.name)).toEqual(["ws_open", "ws_close", "ws_inspect", "ws_reconnect", "ws_open", "submission_terminal"]);
    expect(events[2]).toMatchObject({ outcome: "running", submissionId: "submission-1" });
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("ends observation when SP no longer has the known Submission, without an operation-key fallback", async () => {
    const { opened, openWebSocket } = sockets();
    const { fetch, requests } = queuedFetch(
      Response.json(receipt("running")),
      Response.json({ code: "REQUEST_NOT_FOUND", errMsg: "Submission not found" }, { status: 404 }),
    );
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, openWebSocket });
    const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
    opened[0]!.close();
    await expect(waiting).rejects.toBeInstanceOf(AgentHandleNotFoundError);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([BY_KEY_PATH, BY_ID_PATH]);
    expect(openWebSocket).toHaveBeenCalledOnce();
  });

  it("ends with a retryable 'status unconfirmed' error naming the last status read", async () => {
    const openWebSocket = vi.fn(() => {
      const socket = new FakeSocket();
      queueMicrotask(() => socket.close());
      return socket as unknown as WebSocket;
    });
    const { fetch } = spFetch(() => Response.json(receipt("running")));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, openWebSocket });
    const failure = await harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "SpHarnessError", retryable: true });
    expect((failure as Error).message).toBe("Submission submission-1 status unconfirmed after 3 connections: "
      + "Submission WebSocket closed before terminal status (code 1006); last status read: running");
    expect(openWebSocket).toHaveBeenCalledTimes(3);

    const failing = spFetch((request) => new URL(request.url).pathname === BY_KEY_PATH
      ? Response.json(receipt("running")) : new Response(null, { status: 503 }));
    const unavailable = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch: failing.fetch, openWebSocket });
    await expect(unavailable.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" }))
      .rejects.toMatchObject({ retryable: true, message: expect.stringMatching(/status unconfirmed .* last status read: HTTP 503$/u) });
  });

  it("does not wait for a terminal fact when the known Submission is replaced", async () => {
    const { opened, openWebSocket } = sockets();
    const { fetch } = queuedFetch(Response.json(receipt("running")), Response.json(receipt("running", "submission-2")));
    const harness = createSpHarness({ origin: "https://eval-sp.test", serviceToken: "secret", fetch, openWebSocket });
    const waiting = harness.waitForSubmission({ handle: subject, idempotencyKey: "execution:sampling-1" });
    await vi.waitFor(() => expect(openWebSocket).toHaveBeenCalledOnce());
    opened[0]!.close();
    await expect(waiting).rejects.toMatchObject({ retryable: false });
  });
});
